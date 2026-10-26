import fs from 'node:fs';
import path from 'node:path';
import type { JsonRecord } from './types.js';

/** The current session format puts workspace metadata on its first JSONL line. */
export function readSessionHeader(filePath: string): JsonRecord & { cwd: string } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(10);
    if (newline < 0) throw new Error('Session header is missing or too large');
    const header: unknown = JSON.parse(buffer.toString('utf8', 0, newline));
    if (typeof header !== 'object' || header === null || !('type' in header) || header.type !== 'session'
      || !('cwd' in header) || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) {
      throw new Error('Session header has no absolute working directory');
    }
    return header as JsonRecord & { cwd: string };
  } finally {
    fs.closeSync(fd);
  }
}
