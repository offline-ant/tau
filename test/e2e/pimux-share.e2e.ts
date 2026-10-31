import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';

/*
 * Real pimux, real Pi (faux providers only), the real compiled Tau server and
 * UI in a phone-sized Chromium. The test process plays Emacs: it is the pimux
 * primary on stdio. Private agent and pimux directories, loopback-only ports.
 * Set TAU_E2E_SCREENSHOTS=<dir> to keep screenshots.
 */

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PIMUX = process.env.PIMUX_BIN || path.resolve(root, '../pi-ant/orchestration/pimux/bin/pimux');
const FIXTURE = fileURLToPath(new URL('./fixtures/pimux-faux.ts', import.meta.url));
const SHOTS = process.env.TAU_E2E_SCREENSHOTS || '';
const skip = fs.existsSync(PIMUX) ? false : `pimux not found at ${PIMUX} (set PIMUX_BIN)`;

type Record_ = Record<string, unknown>;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pimux-e2e-'));
const agentDir = path.join(work, 'agent');
const muxDir = path.join(work, 'mux');
const holdDir = path.join(work, 'hold');
const project = path.join(work, 'project');
const password = crypto.randomBytes(12).toString('hex');
const children: ChildProcess[] = [];
let tau: ChildProcess;
let third: Awaited<ReturnType<typeof startMux>>;
let fourth: Awaited<ReturnType<typeof startMux>>;
let base = '';
let browser: Browser;
let context: BrowserContext;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PI_ORCHESTRATION_|PIMUX_|HERDR_|TAU_)/.test(key) || ['PI_NESTED', 'TMUX', 'TMUX_PANE', 'PI_REMOTE', 'PI_CODING_AGENT_SESSION_DIR'].includes(key)) delete env[key];
  }
  return { ...env, PI_CODING_AGENT_DIR: agentDir, PIMUX_DIR: muxDir, FX_HOLD_DIR: holdDir, ...extra };
}

async function until<T>(check: () => T | undefined | false | null | Promise<T | undefined | false | null>, description: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let tauPorts: [number, number] | undefined;

async function startTau() {
  tauPorts ??= [await freePort(), await freePort()];
  const [httpsPort, httpPort] = tauPorts;
  tau = spawn(process.execPath, [path.join(root, 'bin', 'tau.js')], {
    cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({ TAU_HOST: '127.0.0.1', TAU_PORT: String(httpsPort), TAU_HTTP_PORT: String(httpPort), TAU_USER: 'e2e', TAU_PASS: password, TAU_HOSTNAMES: '' }),
  });
  children.push(tau);
  let output = '';
  tau.stdout!.setEncoding('utf8').on('data', (data: string) => { output += data; });
  tau.stderr!.setEncoding('utf8').on('data', (data: string) => { output += data; });
  const port = await until(() => /Local orchestration \(loopback HTTP\): http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1], `Tau listening\n${output}`);
  base = `http://127.0.0.1:${port}`;
}

/** The pimux primary: what Pilish is in real use. */
class Primary {
  readonly records: Record_[] = [];
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  private buffer = '';
  private next = 0;
  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        this.records.push(JSON.parse(this.buffer.slice(0, newline)));
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
    child.stdin!.on('error', () => {});
    this.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  }
  send(record: Record_) { this.child.stdin!.write(JSON.stringify(record) + '\n'); }
  mark() { return this.records.length; }
  find(match: (record: Record_) => boolean, after = 0) { return this.records.slice(after).find(match); }
  waitFor(match: (record: Record_) => boolean, description: string, after = 0) { return until(() => this.find(match, after), description); }
  async request(record: Record_) {
    const id = `p${++this.next}`;
    this.send({ ...record, id });
    return this.waitFor((received) => received.type === 'response' && received.id === id, `response to ${String(record.type)}`);
  }
  async run(message: string) {
    const start = this.mark();
    const response = await this.request({ type: 'prompt', message });
    assert.equal(response.success, true, String(response.error));
    await this.waitFor((record) => record.type === 'agent_settled', `settle after ${message}`, start);
  }
}

function discovery(): Record_[] {
  try {
    return fs.readdirSync(muxDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(muxDir, name), 'utf8')));
  } catch { return []; }
}

async function startMux(name: string, env: Record<string, string>) {
  const sessions = path.join(agentDir, 'sessions', '--project--');
  fs.mkdirSync(sessions, { recursive: true });
  const sessionFile = path.join(sessions, `${name}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: project }) + '\n');
  const child = spawn(process.execPath, [PIMUX, '--', 'pi', '--mode', 'rpc', '--session', sessionFile,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--provider', 'tau-fx', '--model', 'one', '-e', FIXTURE],
  { cwd: project, env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
  const primary = new Primary(child);
  await primary.waitFor((record) => record.type === 'pimux_hello', `${name} primary hello`).catch((error) => { throw new Error(`${error.message}\n${stderr}`); });
  const entry = await until(() => discovery().find((record) => (record.session as Record_ | null)?.file === sessionFile && record.status === 'idle'), `${name} discovery`);
  return { primary, sessionFile, muxId: String(entry.muxId) };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let root1: Awaited<ReturnType<typeof startMux>>;

before(async () => {
  if (skip) return;
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(holdDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'tau-fx', defaultModel: 'one', compaction: { enabled: false }, retry: { enabled: false },
  }));
  const emacs = { host: 'emacs', endpoint: path.join(work, 'emacs-socket'), id: '*pi:project*' };
  root1 = await startMux('root', { PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: emacs.id });
  await startMux('worker', {
    PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: 'do-e2e-worker',
    PI_ORCHESTRATION_PLACEMENT: 'worker', PI_ORCHESTRATION_PARENT: JSON.stringify({ ...emacs, name: emacs.id }),
  });
  third = await startMux('third', { PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: '*pi:third*' });
  fourth = await startMux('fourth', { PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: '*pi:fourth*' });
  await root1.primary.run('first from emacs');
  await startTau();
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
  context = await browser.newContext({ ...devices['Pixel 7'], httpCredentials: { username: 'e2e', password } });
});

after(async () => {
  await context?.close();
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(work, { recursive: true, force: true });
});

const userMessages = (page: Page, text: string) => page.locator('.message.user', { hasText: text });
const assistantText = (page: Page, text: string) => page.locator('.assistant-step-content', { hasText: text });

test('Emacs and a phone share one Pi through pimux and Tau', { skip, timeout: 180000 }, async () => {
  const page = await context.newPage();
  await page.goto(base);

  // With nothing open, the overview shows the shared agents, the worker under its parent.
  const panel = page.locator('.agents-panel');
  await panel.waitFor({ state: 'visible' });
  const rootRow = panel.locator(`.agent-row[data-mux-id="${root1.muxId}"]`);
  await rootRow.waitFor();
  const workerRow = panel.locator('.agent-row.agent-worker');
  assert.equal(await workerRow.getAttribute('style'), '--depth:1');
  assert.match(await workerRow.innerText(), /do-e2e-worker/);
  await shot(page, 'agents-overview');

  // Tapping attaches; the history Emacs already has is there.
  await rootRow.click();
  await panel.waitFor({ state: 'hidden' });
  await userMessages(page, 'first from emacs').waitFor();
  await assistantText(page, 'reply: first from emacs').waitFor();
  assert.ok(fs.existsSync(root1.sessionFile));

  // A prompt from Emacs renders once in the phone.
  await root1.primary.run('second from emacs');
  await assistantText(page, 'reply: second from emacs').waitFor();
  assert.equal(await userMessages(page, 'second from emacs').count(), 1);

  // A prompt from the phone reaches Emacs and renders once in both.
  const before = root1.primary.mark();
  await page.locator('#message-input').fill('hello from phone');
  await page.locator('#send-btn').click();
  await root1.primary.waitFor((record) => record.type === 'message_start' && JSON.stringify((record.message as Record_).content).includes('hello from phone'), 'phone prompt in Emacs', before);
  await root1.primary.waitFor((record) => record.type === 'agent_settled', 'phone prompt settles', before);
  await assistantText(page, 'reply: hello from phone').waitFor();
  assert.equal(await userMessages(page, 'hello from phone').count(), 1);

  // A dialog answered in Emacs closes in the phone.
  let start = root1.primary.mark();
  root1.primary.send({ type: 'prompt', message: '/fx-select' });
  const asked = await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'select', 'dialog', start);
  await page.locator('.dialog-title', { hasText: 'Pick a fruit' }).waitFor();
  root1.primary.send({ type: 'extension_ui_response', id: asked.id, value: 'pear' });
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'picked:pear', 'pear', start);

  // A dialog answered in the phone closes in Emacs, which hears who answered.
  start = root1.primary.mark();
  root1.primary.send({ type: 'prompt', message: '/fx-select' });
  const second = await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'select', 'second dialog', start);
  await page.locator('.dialog-option', { hasText: 'apple' }).click();
  const closed = await root1.primary.waitFor((record) => record.type === 'pimux_dialog_closed' && record.id === second.id, 'closed in Emacs', start);
  assert.equal(closed.reason, 'answered');
  assert.notEqual(closed.clientId, root1.primary.find((record) => record.type === 'pimux_hello')!.clientId);
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'picked:apple', 'apple', start);

  // Two dialogs at once take turns in the phone; neither answers the other with a cancel.
  start = root1.primary.mark();
  root1.primary.send({ type: 'prompt', message: '/fx-two' });
  await page.locator('.dialog-title', { hasText: 'Fruit one' }).waitFor();
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.title === 'Fruit two', 'second dialog at once', start);
  await page.locator('.dialog-option', { hasText: 'pear' }).click();
  await page.locator('.dialog-title', { hasText: 'Fruit two' }).waitFor();
  await page.locator('.dialog-option', { hasText: 'plum' }).click();
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'both:pear,plum', 'both answers', start);

  // A model chosen in Emacs reaches the tab, and reloading mid-reply resumes the stream exactly.
  assert.equal((await root1.primary.request({ type: 'set_model', provider: 'tau-fx-slow', modelId: 'one' })).success, true);
  await until(async () => {
    const live = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ model?: { provider?: string } }> };
    return live.sessions[0]?.model?.provider === 'tau-fx-slow';
  }, 'model change in Tau');
  const words = Array.from({ length: 150 }, (_, index) => `word${index}`).join(' ');
  start = root1.primary.mark();
  await root1.primary.request({ type: 'prompt', message: 'stream 150' });
  await root1.primary.waitFor((record) => record.type === 'message_update', 'streaming started', start);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.reload();
  await assistantText(page, 'word1 ').first().waitFor();
  await root1.primary.waitFor((record) => record.type === 'agent_settled', 'stream settles', start);
  await until(async () => (await assistantText(page, 'word149').allInnerTexts()).some((text) => text.trim() === words), 'full streamed reply after reload');
  assert.equal(await assistantText(page, 'word149').count(), 1, 'the reply renders once');
  await shot(page, 'shared-conversation');

  // A new session in Emacs moves the tab with it, without a reload.
  assert.equal((await root1.primary.request({ type: 'new_session' })).success, true);
  await userMessages(page, 'hello from phone').waitFor({ state: 'detached' });
  const moved = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ sessionFile?: string }> };
  assert.notEqual(moved.sessions[0].sessionFile, root1.sessionFile);

  // Closing the tab only detaches: Emacs keeps its Pi.
  await page.locator('.live-tab.active .live-tab-close').click();
  await until(async () => ((await (await page.request.get(`${base}/api/live-sessions`)).json()) as { sessions: unknown[] }).sessions.length === 0, 'tab closed');
  assert.ok(discovery().some((record) => record.muxId === root1.muxId));
  await root1.primary.request({ type: 'set_model', provider: 'tau-fx', modelId: 'one' });
  await root1.primary.run('still mine');

  // Reattach from the overview; when Emacs's Pi exits, the phone says so.
  await page.locator('#agents-btn').click();
  await panel.locator(`.agent-row[data-mux-id="${root1.muxId}"]`).click();
  await assistantText(page, 'reply: still mine').waitFor();
  root1.primary.child.stdin!.end();
  assert.equal(await root1.primary.exited, 0);
  await page.locator('.system-message', { hasText: 'This agent was closed in emacs.' }).waitFor();
  await assistantText(page, 'reply: still mine').waitFor();
  await shot(page, 'shared-exit');
});

test('hostile discovery text stays text, a slow attach does not steal the view, a Tau restart loses no draft', { skip, timeout: 120000 }, async () => {
  const hostile = path.join(muxDir, 'hostile.json');
  const cwd = '/tmp/x" onpointerenter="window.__owned=1';
  fs.writeFileSync(hostile, JSON.stringify({
    protocol: 1, muxId: 'hostile"x', socket: path.join(muxDir, 'hostile.sock'), pid: process.pid, piPid: process.pid, cwd,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', blocked: null,
    session: { file: null, id: 'h', name: '<img src=x onerror="window.__owned=1">' }, model: null, thinkingLevel: null,
    placement: 'root', orchestration: null, parent: null,
  }), { mode: 0o600 });
  const page = await context.newPage();
  await page.goto(base);
  const panel = page.locator('.agents-panel');
  const title = panel.locator('.agents-group-title', { hasText: 'x" onpointerenter' });
  await title.waitFor();
  assert.equal(await title.getAttribute('title'), cwd);
  assert.equal(await panel.locator('[onpointerenter], img').count(), 0);
  assert.match(await panel.locator('.agent-name', { hasText: '<img' }).innerText(), /^<img src=x/);
  await title.hover();
  assert.equal(await page.evaluate(() => (window as unknown as { __owned?: number }).__owned), undefined);
  fs.rmSync(hostile);

  // Two tabs, then an attach that hangs while the user goes to the other tab.
  await panel.locator(`.agent-row[data-mux-id="${third.muxId}"]`).click();
  await panel.waitFor({ state: 'hidden' });
  await page.locator('#agents-btn').click();
  await panel.locator('.agent-row.agent-worker').click();
  await panel.waitFor({ state: 'hidden' });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/live-sessions/attach', async (route) => { await released; await route.continue(); });
  await page.locator('#agents-btn').click();
  await panel.locator(`.agent-row[data-mux-id="${fourth.muxId}"]`).click();
  const tabs = page.locator('.live-tab');
  await tabs.first().dispatchEvent('click');
  await page.locator('.live-tab.active').first().waitFor();
  const chosen = await page.locator('.live-tab.active').getAttribute('data-session-id');
  release();
  await until(async () => await tabs.count() === 3, 'the slow attach still opens its tab');
  await page.unroute('**/api/live-sessions/attach');
  assert.equal(await page.locator('.live-tab.active').getAttribute('data-session-id'), chosen);
  await page.locator('.agents-close').click();

  // Tau dies: the status tells the truth, and the draft waits for its agent.
  await tabs.first().dispatchEvent('click');
  const live = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ id: string; attached: { muxId: string } }> };
  const activeId = await page.locator('.live-tab.active').getAttribute('data-session-id');
  const activeMux = live.sessions.find((session) => session.id === activeId)!.attached.muxId;
  await page.locator('#message-input').fill('draft for this agent');
  const stopped = new Promise((resolve) => tau.once('exit', resolve));
  tau.kill('SIGKILL');
  await stopped;
  await until(async () => await page.locator('#status-text').innerText() === 'Disconnected', 'disconnected status');
  await page.locator('.live-tab.active').dispatchEvent('click');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.locator('#status-text').innerText(), 'Disconnected');
  await startTau();
  await until(async () => await page.locator('#status-text').innerText() === 'Connected', 'reconnected status', 30000);
  // Tau came back: the page returns to the agent it was showing, draft included.
  await until(async () => await page.locator('#message-input').inputValue() === 'draft for this agent', 'the draft is back on its agent');
  const back = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ id: string; attached: { muxId: string } }> };
  const backId = await page.locator('.live-tab.active').getAttribute('data-session-id');
  assert.equal(back.sessions.find((session) => session.id === backId)?.attached.muxId, activeMux);
  await page.close();
});

test('a shared tab offers only what works: palette, title, queue, status, keyboard, refusals', { skip, timeout: 120000 }, async () => {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, httpCredentials: { username: 'e2e', password } });
  const page = await desk.newPage();
  const phone = await context.newPage();
  await page.goto(base);
  await phone.goto(base);
  const live = async () => (await (await page.request.get(`${base}/api/live-sessions`)).json()) as { sessions: Array<{ id: string; attached?: { muxId: string } }> };
  const panel = page.locator('.agents-panel');
  const openAgent = async (muxId: string) => {
    if (!await panel.isVisible()) await page.locator('#agents-btn').click();
    await panel.locator(`.agent-row[data-mux-id="${muxId}"]`).click();
    await panel.waitFor({ state: 'hidden' });
  };
  await openAgent(fourth.muxId);
  await openAgent(third.muxId);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message-input', 'opening an agent focuses the composer');

  // Only what this tab can do is offered.
  assert.equal(await page.locator('#take-herdr-btn').isVisible(), false);
  await page.locator('#command-btn').click();
  const labels = await page.locator('.command-label').allInnerTexts();
  assert.ok(labels.includes('New session'));
  assert.ok(!labels.includes('Session tree') && !labels.includes('Take from Herdr…'), labels.join());
  await page.keyboard.press('Escape');

  // The tab keeps the agent's name, whatever is said in it.
  const title = page.locator('.live-tab.active .live-tab-title');
  const name = await title.innerText();
  await third.primary.run('a prompt that must not become the title');
  assert.equal(await title.innerText(), name);

  // Status text asks nothing of anyone; a dialog on that tab does.
  await page.locator('.live-tab', { hasText: '*pi:fourth*' }).click();
  await third.primary.request({ type: 'prompt', message: '/fx-status' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.locator('.live-tab-ui-dot').count(), 0);
  await page.locator('.live-tab', { hasText: name }).click();

  // A dialog owns the keyboard, then gives it back.
  const mark = third.primary.mark();
  third.primary.send({ type: 'prompt', message: '/fx-select' });
  await page.locator('.dialog-option').first().waitFor();
  await until(() => page.evaluate(() => document.activeElement?.textContent === 'apple'), 'the first option has focus');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await third.primary.waitFor((record) => record.method === 'notify' && record.message === 'picked:pear', 'keyboard answer', mark);
  await until(() => page.evaluate(() => document.activeElement?.id === 'message-input'), 'focus is back in the composer');

  // Another browser sees the image too.
  await phone.locator('#agents-btn').click();
  await phone.locator(`.agent-row[data-mux-id="${third.muxId}"]`).click();
  await phone.locator('.agents-panel').waitFor({ state: 'hidden' });
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await third.primary.run('with a picture');
  third.primary.send({ type: 'prompt', message: 'with a picture attached', images: [{ type: 'image', data: pixel, mimeType: 'image/png' }] });
  await userMessages(phone, 'with a picture attached').locator('img').waitFor();
  await assistantText(phone, 'reply: with a picture attached').waitFor();
  await third.primary.waitFor((record) => record.type === 'agent_settled', 'picture turn');

  // Busy on a phone: both buttons fit, and what Pi holds is visible everywhere.
  fs.rmSync(path.join(holdDir, 'q1'), { force: true });
  third.primary.send({ type: 'prompt', message: 'hold q1, then answer' });
  await phone.locator('#abort-btn').waitFor();
  await phone.locator('#message-input').fill('steer from the phone');
  await phone.locator('#send-btn').click();
  await phone.locator('.queued-msg', { hasText: 'steer from the phone' }).waitFor();
  await page.locator('.queued-msg', { hasText: 'steer from the phone' }).waitFor();
  const stop = (await phone.locator('#abort-btn').boundingBox())!;
  assert.ok(stop.x + stop.width <= phone.viewportSize()!.width, 'Stop stays on screen');
  const model = (await phone.locator('#model-input').boundingBox())!;
  assert.ok(model.width > 50, 'a long status leaves the model button its room');
  await shot(phone, 'busy-phone');
  fs.writeFileSync(path.join(holdDir, 'q1'), '');
  await assistantText(phone, 'reply: steer from the phone').waitFor();
  await until(async () => await page.locator('.queued-msg').count() === 0, 'the queue empties');

  // A refused delete says why, and the sidebar found the session by itself.
  await page.locator('.project-header').first().click();
  const row = page.locator('.session-item.has-live-session').first();
  await row.waitFor();
  await row.click({ button: 'right' });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.context-menu-item', { hasText: 'Delete' }).click();
  await until(async () => /before deleting it/.test(await page.locator('#status-text').innerText()), 'the refusal is shown');
  assert.equal((await live()).sessions.some((session) => session.attached?.muxId === third.muxId), true);

  await phone.close();
  await desk.close();
});
