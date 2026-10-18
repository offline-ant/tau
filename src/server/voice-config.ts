/*
 * Dictation configuration and credentials.
 *
 * The backend is one global choice in `<agentDir>/voice.json`, written by
 * pi-ant's `/rec-setting` and read at every recording start, so a change
 * applies to the next recording without restarting Tau. Claude dictation uses
 * the native Claude Code subscription login selected the same way as
 * pi-claude-agent's default account. Tau only reads that login: it never
 * refreshes tokens, because a second refresher would race Claude's own.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8090';

export type VoiceConfig = { backend: 'claude' } | { backend: 'local'; localUrl: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === 'string' ? error.code : undefined;
}

/** Missing file selects Claude; anything malformed is an explicit error, never a silent default. */
export function readVoiceConfig(agentDir: string): VoiceConfig {
  const file = path.join(agentDir, 'voice.json');
  let value: unknown;
  try { value = readJson(file); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { backend: 'claude' };
    throw new Error(`Cannot read voice configuration ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const invalid = (reason: string) => new Error(`Invalid voice configuration ${file}: ${reason}`);
  if (!isObject(value) || Object.keys(value).some((key) => key !== 'backend' && key !== 'localUrl')) {
    throw invalid('expected {"backend": "claude" | "local", "localUrl"?: string}');
  }
  if (value.localUrl !== undefined) {
    if (typeof value.localUrl !== 'string' || !/^https?:$/.test(URL.parse(value.localUrl)?.protocol ?? '')) {
      throw invalid('localUrl must be an http(s) URL');
    }
  }
  if (value.backend === 'claude') return { backend: 'claude' };
  if (value.backend === 'local') return { backend: 'local', localUrl: (value.localUrl as string | undefined) ?? DEFAULT_LOCAL_URL };
  throw invalid('backend must be "claude" or "local"');
}

/** Claude config directory of the default pi-claude-agent account, else the native default. */
function claudeConfigDir(agentDir: string, home: string, env: NodeJS.ProcessEnv): { account: string; dir: string } {
  const stateDir = path.join(agentDir, 'claude-agent');
  let accounts: unknown;
  try { accounts = readJson(path.join(stateDir, 'accounts.json')); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new Error(`Cannot read Claude account configuration: ${error instanceof Error ? error.message : String(error)}`);
    return { account: 'native', dir: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') };
  }
  const list = isObject(accounts) && Array.isArray(accounts.accounts) ? accounts.accounts.filter(isObject) : [];
  if (list.length === 0) throw new Error('Claude account configuration lists no accounts.');
  let preferred: unknown;
  try {
    const saved = readJson(path.join(stateDir, 'default-account.json'));
    preferred = isObject(saved) ? saved.account : undefined;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new Error(`Cannot read the default Claude account: ${error instanceof Error ? error.message : String(error)}`);
  }
  const account = list.find((entry) => entry.id === preferred) ?? list[0];
  const dir = typeof account.configDir === 'string' ? account.configDir : path.join(home, '.claude');
  return { account: String(account.id), dir };
}

/** The selected login's current OAuth access token. Never logged, never refreshed here. */
export function claudeAccessToken(agentDir: string, home = os.homedir(), env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const { account, dir } = claudeConfigDir(agentDir, home, env);
  const file = path.join(dir, '.credentials.json');
  let credentials: unknown;
  try { credentials = readJson(file); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`No Claude login for account "${account}" (${file}). Log in with Claude Code first.`);
    throw new Error(`Cannot read the Claude login for account "${account}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const oauth = isObject(credentials) ? credentials.claudeAiOauth : undefined;
  if (!isObject(oauth) || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    throw new Error(`The Claude login for account "${account}" has no subscription access token. Log in with Claude Code.`);
  }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) {
    throw new Error(`The Claude login for account "${account}" expired at ${new Date(oauth.expiresAt).toISOString()}. Use Claude (or a Claude-backed Pi session) once to refresh it; Tau never refreshes tokens.`);
  }
  return oauth.accessToken;
}
