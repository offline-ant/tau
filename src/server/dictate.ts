#!/usr/bin/env node
/*
 * Terminal dictation (`tau-dictate`), used by Emacs.
 *
 * Microphones are shared by `pi-mic` on the machine the user sits at: each
 * one appears as `<host>.sock` in the mic directory (`/tmp/pi-mic-<uid>`,
 * `PI_MIC_DIR` overrides), usually through an SSH reverse forward. A
 * connection records 16 kHz mono linear16 PCM until it is closed. The newest
 * socket that accepts a connection is used, so the device connected last wins.
 *
 * Output is one JSON object per line: `{"type":"ready","device","backend"}`,
 * any number of `{"type":"partial","text"}` previews, then exactly one
 * `{"type":"final","text","limited"?}` or `{"type":"error","message"}`.
 * End of standard input stops the recording and transcribes it; SIGTERM or
 * SIGINT cancels. The speech backend is Tau's dictation backend
 * (`voice.json`); text is printed only, never sent anywhere else.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { PI_AGENT_DIR } from './config.js';
import { SAMPLE_RATE, type Transcriber } from './voice-backends.js';
import { MAX_RECORDING_SECONDS, configuredTranscriber, type OpenTranscriber } from './voice.js';

export type DictationMessage =
  | { type: 'ready'; device: string; backend: string }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; limited?: true }
  | { type: 'error'; message: string };

export function defaultMicDir(): string {
  return process.env.PI_MIC_DIR || path.join('/tmp', `pi-mic-${os.userInfo().uid}`);
}

function connect(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
    socket.once('error', () => resolve(null));
  });
}

/** Connects to the newest live microphone; stale sockets are skipped, never removed. */
export async function connectMicrophone(micDir: string): Promise<{ device: string; socket: net.Socket } | null> {
  let names: string[];
  try { names = fs.readdirSync(micDir).filter((name) => name.endsWith('.sock')); }
  catch { return null; }
  const candidates = names
    .map((name) => {
      const file = path.join(micDir, name);
      try { return { device: name.slice(0, -'.sock'.length), file, mtime: fs.lstatSync(file).mtimeMs }; }
      catch { return null; }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { device, file } of candidates) {
    const socket = await connect(file);
    if (socket) return { device, socket };
  }
  return null;
}

export type DictationOptions = {
  micDir: string;
  open: OpenTranscriber;
  input: Readable;
  emit(message: DictationMessage): void;
  maxSeconds?: number;
  idleMs?: number;
  /** Aborting cancels the recording without a terminal message. */
  signal?: AbortSignal;
};

/** Records one utterance; resolves after the terminal message (or cancellation). */
export async function dictate(options: DictationOptions): Promise<void> {
  const maxBytes = (options.maxSeconds ?? MAX_RECORDING_SECONDS) * SAMPLE_RATE * 2;
  const idleMs = options.idleMs ?? 15_000;
  const mic = await connectMicrophone(options.micDir);
  if (!mic) {
    options.emit({ type: 'error', message: `No microphone connected (${options.micDir}). Run pi-mic on the machine you are using.` });
    return;
  }
  const { device, socket } = mic;
  let transcriber: Transcriber | null = null;
  let received = 0;
  let odd: Buffer | null = null;
  let done = false;
  let finishing = false;
  let idle: NodeJS.Timeout | undefined;

  return new Promise<void>((resolve) => {
    function release() {
      clearTimeout(idle);
      socket.destroy();
      options.input.off('end', stop);
      options.input.pause();
      options.signal?.removeEventListener('abort', cancel);
    }
    function end(message: DictationMessage | null) {
      if (done) return;
      done = true;
      release();
      transcriber?.close();
      if (message) options.emit(message);
      resolve();
    }
    const fail = (message: string) => end({ type: 'error', message });
    function cancel() { end(null); }
    function finish(limited: boolean) {
      if (done || finishing || !transcriber) return;
      finishing = true;
      release();
      if (received === 0) return fail(`The microphone on ${device} produced no audio. Is one plugged in?`);
      transcriber.finish().then(
        (text) => end({ type: 'final', text, ...(limited ? { limited: true as const } : {}) }),
        (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
      );
    }
    function stop() { finish(false); }
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(`No audio from ${device} for ${Math.round(idleMs / 1000)} seconds; recording stopped.`), idleMs);
    };

    options.signal?.addEventListener('abort', cancel);
    if (options.signal?.aborted) return cancel();
    try {
      const opened = options.open({
        partial: (text) => { if (!done && !finishing) options.emit({ type: 'partial', text }); },
        error: fail,
      });
      transcriber = opened.transcriber;
      if (done) return transcriber.close();
      options.emit({ type: 'ready', device, backend: opened.backend });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    socket.on('data', (data: Buffer) => {
      if (done || finishing || !transcriber) return;
      let chunk = odd ? Buffer.concat([odd, data]) : data;
      odd = null;
      if (chunk.length % 2) { odd = chunk.subarray(chunk.length - 1); chunk = chunk.subarray(0, chunk.length - 1); }
      const room = maxBytes - received;
      if (chunk.length > room) chunk = chunk.subarray(0, room);
      received += chunk.length;
      if (chunk.length) transcriber.write(Buffer.from(chunk));
      if (received >= maxBytes) finish(true);
      else resetIdle();
    });
    // A microphone that goes away ends the recording like a stop.
    socket.on('close', () => finish(false));
    socket.on('error', () => {});
    options.input.on('end', stop);
    options.input.resume();
    resetIdle();
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => controller.abort());
  await dictate({
    micDir: defaultMicDir(),
    open: configuredTranscriber(PI_AGENT_DIR),
    input: process.stdin,
    emit: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    signal: controller.signal,
  });
  process.exit(0);
}
