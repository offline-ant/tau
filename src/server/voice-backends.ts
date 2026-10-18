/*
 * Speech-to-text backends. Both receive 16 kHz mono signed 16-bit
 * little-endian PCM and resolve one final transcript; there is no fallback
 * between them.
 *
 * Claude: Claude Code's private streaming endpoint (verified against the
 * 2.1.293 runtime). Binary audio frames go up; `KeepAlive` is sent on open and
 * every 8 s; `CloseStream` finalizes. `TranscriptInterim`/`TranscriptText`
 * replace the pending utterance, `TranscriptEndpoint` commits it. After
 * `CloseStream` the stream resolves on the next endpoint, 1.5 s without any
 * transcript, a 5 s safety limit, or the socket closing; pending text is
 * promoted to final in every case, like Claude Code does.
 *
 * Local: an OpenAI-compatible `/v1/audio/transcriptions` server; the whole
 * recording is posted once as a WAV file.
 */

import { WebSocket } from 'ws';

export const SAMPLE_RATE = 16000;
export const CLAUDE_VOICE_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';
const CLAUDE_USER_AGENT = 'claude-cli/2.1.293 (external, cli)';
const KEEPALIVE = '{"type":"KeepAlive"}';
const CLOSE_STREAM = '{"type":"CloseStream"}';

export type TranscriberEvents = {
  /** Preview of everything heard so far; not final. */
  partial(text: string): void;
  /** Fatal backend failure while recording. */
  error(message: string): void;
};

export interface Transcriber {
  /** Append 16 kHz mono linear16 audio. */
  write(pcm: Buffer): void;
  /** End the audio and resolve the complete transcript. */
  finish(): Promise<string>;
  /** Abandon the recording and release its connections. */
  close(): void;
}

export type ClaudeOptions = {
  token: string;
  url?: string;
  connectTimeoutMs?: number;
  keepAliveMs?: number;
  noDataMs?: number;
  safetyMs?: number;
};

export function claudeTranscriber(options: ClaudeOptions, events: TranscriberEvents): Transcriber {
  const { connectTimeoutMs = 10_000, keepAliveMs = 8_000, noDataMs = 1_500, safetyMs = 5_000 } = options;
  const query = new URLSearchParams({
    encoding: 'linear16', sample_rate: String(SAMPLE_RATE), channels: '1', endpointing_ms: '300',
    utterance_end_ms: '1000', language: 'en', use_conversation_engine: 'true',
  });
  const ws = new WebSocket(`${options.url ?? CLAUDE_VOICE_URL}?${query}`, {
    headers: { Authorization: `Bearer ${options.token}`, 'User-Agent': CLAUDE_USER_AGENT, 'x-app': 'cli', 'anthropic-client-platform': 'claude_code_cli' },
  });
  const committed: string[] = [];
  let pending = '';
  let queued: Buffer[] = [];
  let failure = '';
  let closing = false;
  let finishing: ((reason: 'done' | 'failed') => void) | null = null;
  let noData: NodeJS.Timeout | undefined;
  let safety: NodeJS.Timeout | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  const connectTimer = setTimeout(() => fail('Claude speech service did not connect within 10 seconds.'), connectTimeoutMs);

  const transcript = () => [...committed, pending].filter(Boolean).join(' ');
  const commit = () => { if (pending) committed.push(pending); pending = ''; };
  function release() {
    closing = true;
    clearTimeout(connectTimer);
    clearTimeout(noData);
    clearTimeout(safety);
    clearInterval(keepAlive);
    queued = [];
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  // Finalization timers start only once CloseStream is actually sent.
  function closeStream() {
    ws.send(CLOSE_STREAM);
    noData = setTimeout(() => finishing?.('done'), noDataMs);
    safety = setTimeout(() => finishing?.('done'), safetyMs);
  }
  function fail(message: string) {
    if (closing && !finishing) return;
    failure ||= message;
    if (finishing) finishing('failed');
    else { release(); events.error(message); }
  }

  ws.on('open', () => {
    clearTimeout(connectTimer);
    ws.send(KEEPALIVE);
    keepAlive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(KEEPALIVE); }, keepAliveMs);
    for (const chunk of queued) ws.send(chunk);
    queued = [];
    if (finishing) closeStream();
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let message: { type?: unknown; data?: unknown; description?: unknown; error_code?: unknown; message?: unknown };
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.type === 'TranscriptInterim' || message.type === 'TranscriptText') {
      if (finishing) clearTimeout(noData);
      if (typeof message.data === 'string' && message.data) {
        pending = message.data;
        events.partial(transcript());
      }
    } else if (message.type === 'TranscriptEndpoint') {
      commit();
      if (finishing) finishing('done');
    } else if (message.type === 'TranscriptError') {
      fail(`Claude transcription failed: ${String(message.description ?? message.error_code ?? 'unknown error')}`);
    } else if (message.type === 'error') {
      fail(`Claude speech service error: ${String(message.message ?? 'unknown error')}`);
    }
  });
  ws.on('unexpected-response', (_request, response) => {
    const status = response.statusCode ?? 0;
    response.resume();
    fail(status === 401 || status === 403
      ? `Claude rejected the login (HTTP ${status}). Log in again with Claude Code.`
      : `Claude speech service refused the connection (HTTP ${status}).`);
  });
  ws.on('error', (error) => fail(`Claude speech connection failed: ${error.message}`));
  ws.on('close', (code) => {
    if (finishing) finishing('done');
    else if (!closing) fail(`Claude speech connection closed unexpectedly (code ${code}).`);
  });

  return {
    write(pcm) {
      if (closing || finishing) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      else queued.push(pcm);
    },
    finish() {
      if (failure) return Promise.reject(new Error(failure));
      return new Promise<string>((resolve, reject) => {
        finishing = (reason) => {
          finishing = null;
          commit();
          const text = transcript();
          release();
          if (reason === 'failed' && !text) reject(new Error(failure));
          else resolve(text);
        };
        if (ws.readyState === WebSocket.OPEN) closeStream();
      });
    },
    close: release,
  };
}

export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function localTranscriber(options: { url: string; timeoutMs?: number }): Transcriber {
  let chunks: Buffer[] = [];
  const controller = new AbortController();
  return {
    write(pcm) { chunks.push(pcm); },
    async finish() {
      const pcm = Buffer.concat(chunks);
      chunks = [];
      if (pcm.length === 0) return '';
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav(pcm))], { type: 'audio/wav' }), 'recording.wav');
      form.append('model', 'whisper-1');
      form.append('language', 'en');
      form.append('response_format', 'json');
      const endpoint = new URL('v1/audio/transcriptions', options.url.endsWith('/') ? options.url : `${options.url}/`);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST', body: form,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]),
        });
      } catch (error) {
        throw new Error(`Local transcription server ${endpoint.origin} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const body = await response.text();
      if (!response.ok) throw new Error(`Local transcription failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
      let text: unknown;
      try { text = (JSON.parse(body) as { text?: unknown }).text; } catch {}
      if (typeof text !== 'string') throw new Error('Local transcription server returned no text.');
      return text.trim();
    },
    close() { chunks = []; controller.abort(); },
  };
}
