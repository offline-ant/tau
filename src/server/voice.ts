/*
 * Dictation socket (`/ws/voice`).
 *
 * The browser streams 16 kHz mono linear16 PCM as binary frames and sends
 * `{"type":"stop"}` when done. Tau replies `{"type":"ready","backend"}`, any
 * number of `{"type":"partial","text"}` previews, then exactly one terminal
 * `{"type":"final","text","limited"?}` or `{"type":"error","message"}` before
 * closing. Closing the socket cancels the recording. Audio and text never
 * reach Pi: nothing is prompted, stored, or written to session history.
 * Settings and speech backends come from pi-sound.
 */

import { WebSocket } from 'ws';

import { IDLE_MS, MAX_RECORDING_SECONDS, SAMPLE_RATE, type OpenTranscriber, type Transcriber } from 'pi-sound';

export { configuredTranscriber } from 'pi-sound';

export const VOICE_PATH = '/ws/voice';
export const MAX_FRAME_BYTES = 64 * 1024;

export type VoiceLimits = { maxSeconds?: number; idleMs?: number };

export function handleVoiceSocket(ws: WebSocket, open: OpenTranscriber, limits: VoiceLimits = {}): void {
  const maxBytes = (limits.maxSeconds ?? MAX_RECORDING_SECONDS) * SAMPLE_RATE * 2;
  const idleMs = limits.idleMs ?? IDLE_MS;
  let transcriber: Transcriber | null = null;
  let received = 0;
  let done = false;
  let idle: NodeJS.Timeout | undefined;
  let finishing = false;
  let stopRequested = false;
  const controller = new AbortController();

  function release() {
    clearTimeout(idle);
    controller.abort();
    const current = transcriber;
    transcriber = null;
    current?.close();
  }
  const send = (message: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  function end(message: object) {
    if (done) return;
    done = true;
    release();
    send(message);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  }
  const fail = (message: string) => end({ type: 'error', message });
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => fail(`No audio received for ${Math.round(idleMs / 1000)} seconds; recording stopped.`), idleMs);
  };
  function finish(limited: boolean) {
    if (done || finishing || !transcriber) return;
    finishing = true;
    clearTimeout(idle);
    // A backend may throw before returning its finish promise.
    try {
      transcriber.finish().then(
        (text) => end({ type: 'final', text, ...(limited ? { limited: true } : {}) }),
        (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
      );
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  }

  const cancel = () => { done = true; release(); };
  ws.on('close', cancel);
  ws.on('error', cancel);
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (done || finishing) return;
    if (!isBinary) {
      let message: { type?: unknown } = {};
      try { message = JSON.parse(String(data)); } catch {}
      if (message.type === 'stop') {
        stopRequested = true;
        finish(false);
      }
      else fail('Unknown voice message.');
      return;
    }
    if (!transcriber) return fail('Audio received before the speech backend was ready. Wait for the ready message before sending PCM.');
    if (stopRequested) return;
    if (data.length > MAX_FRAME_BYTES) return fail('Audio frame exceeds the 64 KiB limit.');
    if (data.length % 2 !== 0) return fail('Audio frames must contain whole 16-bit samples.');
    const room = maxBytes - received;
    const chunk = data.length > room ? data.subarray(0, room) : data;
    received += chunk.length;
    try { if (chunk.length) transcriber.write(Buffer.from(chunk)); }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    if (done) return;
    if (received >= maxBytes) finish(true);
    else resetIdle();
  });

  idle = setTimeout(() => fail('The speech backend did not become ready in time; recording stopped.'), idleMs);

  // Install cancellation before opening. A backend can call error synchronously,
  // reject asynchronously, or resolve after this client has already disconnected.
  async function initialize() {
    try {
      const opened = await open({
        partial: (text) => { if (!done && !finishing && transcriber) send({ type: 'partial', text }); },
        error: fail,
      }, controller.signal);
      if (done) { opened.transcriber.close(); return; }
      transcriber = opened.transcriber;
      send({ type: 'ready', backend: opened.backend });
      if (stopRequested) finish(false);
      else resetIdle();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  void initialize();
}
