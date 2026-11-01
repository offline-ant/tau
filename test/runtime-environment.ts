// Import first: every runtime/ownership/discovery namespace is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';
export const runtimeEnvironment = createClaimTestEnvironment();
export const agent = path.join(runtimeEnvironment.root, 'agent');
export const cwd = path.join(runtimeEnvironment.root, 'project');
for (const directory of [agent, cwd, path.join(runtimeEnvironment.root, 'tmp'), path.join(runtimeEnvironment.root, 'home')]) fs.mkdirSync(directory, { mode: 0o700 });
for (const name of Object.keys(process.env)) {
  if (/^(PI_|PIMUX_|PHIMACS_|HERDR_|TAU_|ANTHROPIC_|OPENAI_|CLAUDE_)/.test(name) || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS'].includes(name)) delete process.env[name];
}
Object.assign(process.env, runtimeEnvironment.env, { HOME: path.join(runtimeEnvironment.root, 'home'),
  TMPDIR: path.join(runtimeEnvironment.root, 'tmp'), PI_CODING_AGENT_DIR: agent,
  PI_CODING_AGENT_SESSION_DIR: runtimeEnvironment.sessions, TAU_PORT: '0', TAU_HTTP_PORT: '0', TAU_HOST: '127.0.0.1' });
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ tau: { authEnabled: false }, packages: [] }), { mode: 0o600 });
