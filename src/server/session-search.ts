import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export type SessionSearchResult = {
  filePath: string;
  dir: string;
  file: string;
  project: string;
  sessionId: string;
  sessionName: string;
  sessionTimestamp: string;
  firstMessage: string;
  matches: { role: string; snippet: string }[];
};

/** Read saved message text only for an explicit search, never for sidebar summaries. */
export async function searchSessions(root: string, query: string): Promise<SessionSearchResult[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2 || !fs.existsSync(root)) return [];
  const realRoot = fs.realpathSync(root);
  const results: SessionSearchResult[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(root, dir.name);
    if (!inside(realRoot, fs.realpathSync(projectDir))) continue;
    for (const file of fs.readdirSync(projectDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= 30) return results;
      // Do not follow symlinks, open named pipes, or interpret percent escapes in names.
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const filePath = path.resolve(projectDir, file.name);
      try {
        if (!inside(realRoot, fs.realpathSync(filePath))) continue;
        const result = await searchFile(filePath, dir.name, file.name, q);
        if (result.matches.length) results.push(result);
      } catch (error) {
        // A session may disappear while it is being searched.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return results;
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function searchFile(filePath: string, dir: string, file: string, query: string): Promise<SessionSearchResult> {
  const result: SessionSearchResult = {
    filePath, dir, file, project: '', sessionId: '', sessionName: '', sessionTimestamp: '', firstMessage: '', matches: [],
  };
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'session') {
        if (typeof entry.id === 'string') result.sessionId = entry.id;
        if (typeof entry.timestamp === 'string') result.sessionTimestamp = entry.timestamp;
        if (typeof entry.cwd === 'string') result.project = entry.cwd;
      } else if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
        result.sessionName = entry.name.trim();
      } else if (entry.type === 'message' && entry.message) {
        const content = entry.message.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ') : '';
        if (!result.firstMessage && entry.message.role === 'user' && text) result.firstMessage = text.slice(0, 120);
        const index = text.toLowerCase().indexOf(query);
        if (index < 0 || result.matches.length >= 3) continue;
        const end = index + query.length + 60;
        result.matches.push({
          role: typeof entry.message.role === 'string' ? entry.message.role : 'unknown',
          snippet: `${index > 60 ? '…' : ''}${text.slice(Math.max(0, index - 60), end).replace(/\r?\n/g, ' ')}${end < text.length ? '…' : ''}`,
        });
      }
      // Names can be appended after the third match, so finish reading metadata.
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return result;
}
