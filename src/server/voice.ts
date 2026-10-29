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

  const send = (message: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  function end(message: object) {
    if (done) return;
    done = true;
    clearTimeout(idle);
    transcriber?.close();
    send(message);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  }
  const fail = (message: string) => end({ type: 'error', message });
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => fail(`No audio received for ${Math.round(idleMs / 1000)} seconds; recording stopped.`), idleMs);
  };
  let finishing = false;
  function finish(limited: boolean) {
    if (done || finishing || !transcriber) return;
    finishing = true;
    clearTimeout(idle);
    transcriber.finish().then(
      (text) => end({ type: 'final', text, ...(limited ? { limited: true } : {}) }),
      (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
    );
  }

  ws.on('close', () => { done = true; clearTimeout(idle); transcriber?.close(); });
  ws.on('error', () => { done = true; clearTimeout(idle); transcriber?.close(); });
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (done || finishing || !transcriber) return;
    if (!isBinary) {
      let message: { type?: unknown } = {};
      try { message = JSON.parse(String(data)); } catch {}
      if (message.type === 'stop') finish(false);
      else fail('Unknown voice message.');
      return;
    }
    if (data.length % 2 !== 0) return fail('Audio frames must contain whole 16-bit samples.');
    const room = maxBytes - received;
    const chunk = data.length > room ? data.subarray(0, room) : data;
    received += chunk.length;
    if (chunk.length) transcriber.write(Buffer.from(chunk));
    if (received >= maxBytes) finish(true);
    else resetIdle();
  });

  try {
    const opened = open({
      partial: (text) => { if (!done && !finishing) send({ type: 'partial', text }); },
      error: fail,
    });
    transcriber = opened.transcriber;
    // A synchronous backend error may already have ended the socket.
    if (done) transcriber.close();
    else { send({ type: 'ready', backend: opened.backend }); resetIdle(); }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
