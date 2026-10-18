/*
 * Dictation: record the microphone, stream 16 kHz mono linear16 PCM to Tau's
 * `/ws/voice` socket, and insert the final transcript once at the textarea's
 * current selection. The draft is never replaced or submitted; partial text
 * is only previewed in the voice status line. Every exit path releases the
 * microphone, audio graph, and socket.
 */

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms per socket frame
const WORKLET = `registerProcessor('tau-pcm', class extends AudioWorkletProcessor {
  process(inputs) { const channel = inputs[0] && inputs[0][0]; if (channel) this.port.postMessage(channel.slice(0)); return true; }
});`;

/** Box-filter downsampling from the device rate to 16 kHz, continuous across chunks. */
export class Downsampler {
  private readonly ratio: number;
  private carry = new Float32Array(0);
  private position = 0;

  constructor(inputRate: number) {
    this.ratio = inputRate / SAMPLE_RATE;
  }

  push(input: Float32Array): Int16Array {
    const buffer = new Float32Array(this.carry.length + input.length);
    buffer.set(this.carry);
    buffer.set(input, this.carry.length);
    const output: number[] = [];
    while (this.position + this.ratio <= buffer.length) {
      const start = Math.floor(this.position);
      const end = Math.max(start + 1, Math.floor(this.position + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buffer[i];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      output.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
      this.position += this.ratio;
    }
    const consumed = Math.floor(this.position);
    this.carry = buffer.slice(consumed);
    this.position -= consumed;
    return Int16Array.from(output);
  }
}

/** Insert dictated text at the selection, adding spaces only where words would touch. */
export function insertAtSelection(input: HTMLTextAreaElement, text: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`;
  input.setRangeText(insert, start, end, 'end');
  input.dispatchEvent(new Event('input'));
}

type Recording = {
  stream?: MediaStream;
  context?: AudioContext;
  socket?: WebSocket;
  pending: Int16Array[];
  pendingSamples: number;
  stopping: boolean;
};

export type VoiceInput = { cancel(): void };

export function setupVoiceInput(micBtn: HTMLElement, input: HTMLTextAreaElement, statusLine: HTMLElement): VoiceInput {
  let recording: Recording | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  function showStatus(text: string, kind: 'active' | 'error' | 'info' = 'active') {
    clearTimeout(statusTimer);
    statusLine.textContent = text;
    statusLine.className = `voice-status ${kind}`;
    if (kind !== 'active') statusTimer = setTimeout(() => statusLine.classList.add('hidden'), 4000);
  }
  function setButton(state: 'idle' | 'recording' | 'transcribing') {
    micBtn.classList.toggle('recording', state === 'recording');
    micBtn.classList.toggle('transcribing', state === 'transcribing');
    micBtn.title = state === 'recording' ? 'Stop recording' : state === 'transcribing' ? 'Transcribing…' : 'Voice input';
  }

  /** Releases everything this recording holds; safe to call repeatedly. */
  function release(target: Recording) {
    target.stream?.getTracks().forEach((track) => track.stop());
    target.context?.close().catch(() => {});
    if (target.socket && target.socket.readyState <= WebSocket.OPEN) target.socket.close();
    if (recording === target) {
      recording = null;
      setButton('idle');
    }
  }
  function abort(target: Recording, message: string) {
    release(target);
    showStatus(message, 'error');
  }

  function sendAudio(target: Recording, flush: boolean) {
    const socket = target.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!flush && target.pendingSamples < FRAME_SAMPLES) return;
    if (target.pendingSamples === 0) return;
    const frame = new Int16Array(target.pendingSamples);
    let offset = 0;
    for (const part of target.pending) { frame.set(part, offset); offset += part.length; }
    target.pending = [];
    target.pendingSamples = 0;
    socket.send(frame.buffer);
  }

  async function start() {
    const target: Recording = { pending: [], pendingSamples: 0, stopping: false };
    recording = target;
    setButton('recording');
    showStatus('Starting microphone…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      target.stream = stream;
      if (recording !== target) return release(target);
      const context = new AudioContext();
      target.context = context;
      const module = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
      if (recording !== target) return release(target);

      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
      target.socket = socket;
      socket.addEventListener('open', () => sendAudio(target, target.stopping));
      socket.addEventListener('message', (event) => {
        let message: { type?: string; text?: string; message?: string; backend?: string; limited?: boolean };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (recording !== target) return;
        if (message.type === 'ready') showStatus(`Listening (${message.backend})… tap the microphone to stop`);
        else if (message.type === 'partial' && !target.stopping) showStatus(`Listening: ${message.text}`);
        else if (message.type === 'error') abort(target, `Voice input: ${message.message}`);
        else if (message.type === 'final') {
          release(target);
          if (message.text) {
            insertAtSelection(input, message.text);
            if (message.limited) showStatus('Recording limit reached; transcript inserted.', 'info');
            else statusLine.classList.add('hidden');
          } else showStatus('No speech recognized.', 'info');
        }
      });
      socket.addEventListener('close', () => { if (recording === target) abort(target, 'Voice connection closed before a transcript arrived.'); });

      const node = new AudioWorkletNode(context, 'tau-pcm');
      const downsampler = new Downsampler(context.sampleRate);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (target.stopping) return;
        const samples = downsampler.push(event.data);
        target.pending.push(samples);
        target.pendingSamples += samples.length;
        sendAudio(target, false);
      };
      context.createMediaStreamSource(stream).connect(node);
      node.connect(context.destination); // the worklet outputs silence; this keeps it pulled
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      abort(target, name === 'NotAllowedError' ? 'Microphone permission was denied.'
        : name === 'NotFoundError' ? 'No microphone found.'
        : `Voice input failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function stop(target: Recording) {
    target.stopping = true;
    target.stream?.getTracks().forEach((track) => track.stop());
    target.context?.close().catch(() => {});
    if (!target.socket) return release(target); // still starting: nothing recorded yet
    setButton('transcribing');
    showStatus('Transcribing…');
    sendAudio(target, true);
    if (target.socket.readyState === WebSocket.OPEN) target.socket.send(JSON.stringify({ type: 'stop' }));
    else target.socket.addEventListener('open', () => target.socket?.send(JSON.stringify({ type: 'stop' })), { once: true });
  }

  const supported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
  if (!supported) {
    micBtn.classList.add('unavailable');
    micBtn.title = window.isSecureContext ? 'Voice input is not supported by this browser' : 'Voice input needs HTTPS (or localhost)';
  }
  micBtn.addEventListener('click', () => {
    if (!supported) return showStatus(`${micBtn.title}.`, 'error');
    if (!recording) void start();
    else if (!recording.stopping) stop(recording);
  });

  return {
    cancel() {
      if (!recording) return;
      release(recording);
      statusLine.classList.add('hidden');
    },
  };
}
