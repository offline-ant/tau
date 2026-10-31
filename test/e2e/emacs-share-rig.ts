import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Disposable parts of the three-way test: an Emacs daemon on a copy of symlinks
 * to the real configuration, in a terminal frame of a private tmux server, and
 * the real compiled Tau on private ports. Everything lives in one private
 * directory; Pi runs through real pimux with faux providers only.
 */

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const workspace = path.dirname(root);
const CONFIG = process.env.TAU_EMACS_CONFIG || path.join(os.homedir(), '.emacs.d');
const PIMUX = process.env.PIMUX_BIN || path.join(workspace, 'pi-ant/orchestration/pimux/bin/pimux');
const ORCHESTRATION = path.dirname(path.dirname(path.dirname(PIMUX)));
const FIXTURE = fileURLToPath(new URL('./fixtures/pimux-faux.ts', import.meta.url));
const ELISP = fileURLToPath(new URL('./fixtures/emacs-share.el', import.meta.url));

export const skip = process.env.TAU_EMACS_E2E !== '1' ? 'set TAU_EMACS_E2E=1 (needs the real Emacs configuration, tmux and Chromium)'
  : !fs.existsSync(PIMUX) ? `pimux not found at ${PIMUX} (set PIMUX_BIN)`
    : !fs.existsSync(path.join(CONFIG, 'init.el')) ? `no Emacs configuration at ${CONFIG}` : false;

/** Decoded `es-reply`; each call site knows its shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Reply = any;

export async function until<T>(check: () => T | undefined | false | null | Promise<T | undefined | false | null>, description: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { env, timeout, encoding: 'utf8' },
    (error, stdout, stderr) => (error ? reject(new Error(`${command} ${args.join(' ').slice(0, 200)}: ${stderr || error.message}`)) : resolve(stdout))));
}

function lisp(value: string) {
  return JSON.stringify(value);
}

export class Rig {
  readonly work = fs.mkdtempSync(path.join('/tmp', 'es-'));
  readonly agentDir = path.join(this.work, 'agent');
  readonly muxDir = path.join(this.work, 'mux');
  readonly tmpDir = path.join(this.work, 'tmp');
  readonly holdDir = path.join(this.work, 'hold');
  readonly initDir = path.join(this.work, 'emacs');
  readonly socket = path.join(this.work, 'server');
  readonly tmuxSocket = path.join(this.work, 'tmux');
  readonly projects = { alpha: path.join(this.work, 'alpha'), beta: path.join(this.work, 'beta') };
  readonly password = crypto.randomBytes(12).toString('hex');
  readonly stateFile = path.join(this.initDir, 'var/pi-deck/state.eld');
  tau: ChildProcess | null = null;
  tauOutput = '';
  base = '';
  private httpPort = 0;
  private httpsPort = 0;

  private environment(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(PI_|PIMUX_|HERDR_|TAU_|DBUS_|XDG_|KDE_|WAYLAND_)/.test(key)
        || ['TMUX', 'TMUX_PANE', 'DISPLAY', 'XAUTHORITY', 'COLORTERM', 'SESSION_MANAGER', 'INSIDE_EMACS'].includes(key)) delete env[key];
    }
    return { ...env, PI_CODING_AGENT_DIR: this.agentDir, PIMUX_DIR: this.muxDir, TMPDIR: this.tmpDir, FX_HOLD_DIR: this.holdDir, ...extra };
  }

  async start() {
    for (const dir of [this.agentDir, this.tmpDir, this.holdDir, this.initDir, ...Object.values(this.projects)]) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.muxDir, { mode: 0o700 });
    fs.writeFileSync(path.join(this.agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'tau-fx', defaultModel: 'one', compaction: { enabled: false }, retry: { enabled: false },
    }));
    await this.startEmacs();
    this.httpPort = await freePort();
    this.httpsPort = await freePort();
    await this.startTau();
  }

  private async startEmacs() {
    const generated = new Set(['.git', 'var', 'eln-cache', 'auto-save-list', 'tramp', 'transient']);
    for (const name of fs.readdirSync(CONFIG)) {
      if (!generated.has(name)) fs.symlinkSync(path.join(CONFIG, name), path.join(this.initDir, name));
    }
    fs.mkdirSync(path.join(this.initDir, 'var'));
    fs.symlinkSync(path.join(CONFIG, 'var/ghostel'), path.join(this.initDir, 'var/ghostel'));
    const piArgs = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', FIXTURE, '-e', ORCHESTRATION, '--provider', 'tau-fx', '--model', 'one'];
    fs.writeFileSync(path.join(this.initDir, 'var/custom.el'), `
(setq native-comp-jit-compilation nil
      pilish-extra-args '(${piArgs.map(lisp).join(' ')})
      pi-deck-new-space-action 'dired)
;; The configuration sets the executable in the package's :init.
(with-eval-after-load 'pilish
  (setq pilish-executable '(${lisp(PIMUX)} "--" "pi")))
`);
    await run('emacs', [`--init-directory=${this.initDir}`, `--daemon=${this.socket}`], this.environment({}), 180000);
    await this.emacsclient(`(load ${lisp(ELISP)} nil t)`);
    await run('tmux', ['-S', this.tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'desk', '-x', '190', '-y', '44',
      `emacsclient -s ${this.socket} -t`, ';', 'set-option', '-g', 'escape-time', '0'], this.environment({ TERM: 'tmux-256color' }), 10000);
    await until(() => this.emacsclient('(length (frames-on-display-list))').then((text) => Number(text) > 0).catch(() => false), 'Emacs frame');
  }

  private emacsclient(expression: string, timeoutMs = 30000) {
    return run('emacsclient', ['-s', this.socket, '--eval', expression], this.environment({}), timeoutMs);
  }

  /** Calls a function of fixtures/emacs-share.el. */
  async call(name: string, ...args: Array<string | number>): Promise<Reply> {
    const expression = `(${name} ${args.map((arg) => (typeof arg === 'number' ? String(arg) : lisp(arg))).join(' ')})`;
    const reply = (await this.emacsclient(expression, 60000)).trim();
    return JSON.parse(Buffer.from(reply.replace(/^"|"$/g, ''), 'base64').toString('utf8'));
  }

  state(name: string) { return this.call('es-state', name); }
  async count(name: string, text: string): Promise<number> { return (await this.call('es-count', name, text)).count; }
  /** Sends keys to the terminal frame. */
  keys(...keys: string[]) { return run('tmux', ['-S', this.tmuxSocket, 'send-keys', '-t', 'desk', ...keys], this.environment({}), 5000); }
  screen() { return run('tmux', ['-S', this.tmuxSocket, 'capture-pane', '-p', '-t', 'desk'], this.environment({}), 5000); }
  release(name: string) { fs.writeFileSync(path.join(this.holdDir, name), ''); }

  discovery(): Reply[] {
    try {
      return fs.readdirSync(this.muxDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(this.muxDir, name), 'utf8')));
    } catch { return []; }
  }

  async startTau() {
    this.tauOutput = '';
    const tau = spawn(process.execPath, [path.join(root, 'bin', 'tau.js')], {
      cwd: this.work, stdio: ['ignore', 'pipe', 'pipe'],
      env: this.environment({ TAU_HOST: '127.0.0.1', TAU_PORT: String(this.httpsPort), TAU_HTTP_PORT: String(this.httpPort), TAU_USER: 'phone', TAU_PASS: this.password, TAU_HOSTNAMES: '' }),
    });
    this.tau = tau;
    tau.stdout!.setEncoding('utf8').on('data', (data: string) => { this.tauOutput += data; });
    tau.stderr!.setEncoding('utf8').on('data', (data: string) => { this.tauOutput += data; });
    await until(() => this.tauOutput.includes(`http://127.0.0.1:${this.httpPort}`), 'Tau listening');
    this.base = `http://127.0.0.1:${this.httpPort}`;
  }

  async stopTau() {
    const tau = this.tau;
    if (!tau || tau.exitCode !== null || tau.signalCode !== null) return;
    const exited = new Promise((resolve) => tau.once('exit', resolve));
    tau.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
    if (tau.exitCode === null && tau.signalCode === null) tau.kill('SIGKILL');
    this.tau = null;
  }

  /** Stops everything this rig started and reports processes it left behind. */
  async stop() {
    await this.stopTau();
    await this.emacsclient('(kill-emacs)', 15000).catch(() => {});
    await run('tmux', ['-S', this.tmuxSocket, 'kill-server'], this.environment({}), 5000).catch(() => {});
    const leftovers = await until(async () => {
      const listing = (await run('ps', ['-eo', 'pid=,args='], process.env, 5000)).split('\n')
        .filter((line) => line.includes(this.work) && !/\bps -eo\b/.test(line));
      return listing.length === 0 ? [] : false;
    }, 'every process of the rig to exit', 15000).catch(async () => {
      const lines = (await run('ps', ['-eo', 'pid=,args='], process.env, 5000)).split('\n').filter((line) => line.includes(this.work));
      for (const line of lines) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ } }
      return lines;
    });
    fs.rmSync(this.work, { recursive: true, force: true });
    return leftovers;
  }
}
