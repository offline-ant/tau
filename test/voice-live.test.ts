/*
 * Opt-in live check of Claude's private speech endpoint with the configured
 * subscription login. Disabled by default; it uses subscription quota.
 *   TAU_VOICE_LIVE=1 node --test test/voice-live.test.ts
 * Requires flite and ffmpeg to synthesize the spoken sample.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccessToken } from '../bin/voice-config.js';
import { claudeTranscriber } from '../bin/voice-backends.js';

const enabled = process.env.TAU_VOICE_LIVE === '1';

test('live Claude dictation transcribes synthesized English speech', { skip: !enabled && 'set TAU_VOICE_LIVE=1' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-voice-live-'));
  const wav = path.join(dir, 'speech.wav');
  let pcm: Buffer;
  try {
    execFileSync('flite', ['-t', 'The quick brown fox jumps over the lazy dog.', '-o', wav]);
    pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', wav, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const errors: string[] = [];
  const transcriber = claudeTranscriber({ token: claudeAccessToken(agentDir) }, { partial: () => {}, error: (message: string) => errors.push(message) });
  // Stream in real time, 100 ms per frame, followed by a second of silence.
  const audio = Buffer.concat([pcm, Buffer.alloc(32000)]);
  for (let offset = 0; offset < audio.length; offset += 3200) {
    transcriber.write(audio.subarray(offset, offset + 3200));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const text = await transcriber.finish();
  assert.deepEqual(errors, []);
  console.log(`[voice-live] transcript: ${text}`);
  assert.match(text.toLowerCase(), /quick brown fox/);
});
