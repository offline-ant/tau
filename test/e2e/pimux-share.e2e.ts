import { runtimeEnvironment, agent as agentDir, cwd as project } from '../runtime-environment.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { startRuntime, stopRuntime, listRuntimes, type RuntimeReceipt } from '@phimacs/pimux/runtime';
import { processIdentityStatus, readProcessIdentity } from '@phimacs/pimux/process-identity';
import { releaseHost } from '../../bin/config.js';
import { DetachedPeer, until } from './fixtures/detached-peer.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';

/*
 * Real pimux, real Pi (faux providers only), the real compiled Tau server and
 * UI in a phone-sized Chromium. The test process plays a socket frontend:
 * creators and browsers have equal lifetime rights, including zero clients.
 * Set TAU_E2E_SCREENSHOTS=<dir> to keep screenshots.
 */

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE = fileURLToPath(new URL('./fixtures/pimux-faux.ts', import.meta.url));
const SHOTS = process.env.TAU_E2E_SCREENSHOTS || '';

type Record_ = Record<string, unknown>;
const work = runtimeEnvironment.root;
const muxDir = process.env.PIMUX_DIR!;
const holdDir = path.join(work, 'hold');
const password = crypto.randomBytes(12).toString('hex');
const children: ChildProcess[] = [];
const runtimes: RuntimeReceipt[] = [];
const peers = new Set<DetachedPeer>();
let tau: ChildProcess;
let third: Awaited<ReturnType<typeof startMux>>;
let fourth: Awaited<ReturnType<typeof startMux>>;
let base = '';
let browser: Browser;
let context: BrowserContext;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, PI_CODING_AGENT_DIR: agentDir, PIMUX_DIR: muxDir, FX_HOLD_DIR: holdDir, ...extra };
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

function discovery() { return listRuntimes(); }

async function peerFor(receipt: RuntimeReceipt) {
  const peer = await DetachedPeer.connect(receipt);
  peers.add(peer);
  return peer;
}

async function startMux(name: string, env: Record<string, string>) {
  const sessions = path.join(runtimeEnvironment.sessions, '--project--');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessions, `${name}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: project }) + '\n', { mode: 0o600 });
  const host = releaseHost();
  const receipt = await startRuntime({ command: host.executable, expectedHost: host, cwd: project, env: cleanEnv(env),
    args: ['--mode', 'rpc', '--session', sessionFile, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--provider', 'tau-fx', '--model', 'one', '-e', FIXTURE],
    ...(env.PI_ORCHESTRATION_PLACEMENT === 'worker' ? { parent: { process: readProcessIdentity(process.pid)!, taskId: name } } : {}),
  });
  runtimes.push(receipt);
  assert.equal(receipt.protocol, 2);
  assert.equal(receipt.state, 'committed');
  return { primary: await peerFor(receipt), sessionFile, muxId: receipt.muxId, receipt };
}

async function stopTau(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
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
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(holdDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    packages: [], defaultProvider: 'tau-fx', defaultModel: 'one', compaction: { enabled: false }, retry: { enabled: false },
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
  for (const child of children.reverse()) await stopTau(child);
  for (const peer of peers) await peer.disconnect();
  for (const receipt of runtimes.reverse()) await stopRuntime(receipt.muxId);
  fs.rmSync(work, { recursive: true, force: true });
});

const userMessages = (page: Page, text: string) => page.locator('.message.user', { hasText: text });
const assistantText = (page: Page, text: string) => page.locator('.assistant-step-content', { hasText: text });

test('a socket frontend and a phone share one detached Pi through pimux and Tau', { timeout: 180000 }, async t => {
  const page = await context.newPage();
  t.after(() => page.close());
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
  const piIdentity = readProcessIdentity(root1.receipt.piPid)!;
  assert.ok(piIdentity);
  const stop = await stopRuntime(root1.muxId);
  assert.equal(stop.state, 'stopped');
  assert.equal(processIdentityStatus(piIdentity), 'dead');
  await page.locator('.system-message', { hasText: 'This agent was closed in emacs.' }).waitFor();
  await assistantText(page, 'reply: still mine').waitFor();
  await shot(page, 'shared-exit');
});

test('hostile discovery text stays text, a slow attach does not steal the view, a Tau restart loses no draft', { timeout: 120000 }, async t => {
  const hostile = path.join(muxDir, 'hostile.json');
  const cwd = `${work}/x" onpointerenter="window.__owned=1`;
  fs.writeFileSync(hostile, JSON.stringify({
    ...discovery()[0], protocol: 2, muxId: 'hostile"x', socket: path.join(muxDir, 'hostile.sock'), pid: process.pid, piPid: process.pid, cwd,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', blocked: null,
    session: { file: null, id: 'h', name: '<img src=x onerror="window.__owned=1">' }, model: null, thinkingLevel: null,
    placement: 'root', orchestration: null, parent: null,
  }), { mode: 0o600 });
  const page = await context.newPage();
  t.after(() => page.close());
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
  // Reconnection never submits or silently moves preserved input. Recovery is
  // bound to its old agent and context and requires an explicit Reuse action.
  await page.locator('#recovered-input .queued-msg', { hasText: 'draft for this agent' }).waitFor();
  assert.equal(await page.locator('#message-input').inputValue(), '');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reuse', exact: true }).click();
  await until(async () => await page.locator('#message-input').inputValue() === 'draft for this agent', 'explicitly reused draft');
  const back = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ id: string; attached: { muxId: string } }> };
  const backId = await page.locator('.live-tab.active').getAttribute('data-session-id');
  assert.equal(back.sessions.find((session) => session.id === backId)?.attached.muxId, activeMux);
  await page.close();
});

test('a shared tab offers advertised tree navigation and equal root actions, title, queue, status, keyboard and refusals', { timeout: 120000 }, async t => {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, httpCredentials: { username: 'e2e', password } });
  const page = await desk.newPage();
  const phone = await context.newPage();
  t.after(async () => { await phone.close(); await desk.close(); });
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

  // Root actions do not depend on which frontend created this runtime. Tree
  // navigation still requires its extension, which this fixture does not load.
  assert.equal(await page.locator('#take-herdr-btn').isVisible(), true);
  await page.locator('#command-btn').click();
  const labels = await page.locator('.command-label').allInnerTexts();
  assert.ok(labels.includes('New session'));
  assert.ok(!labels.includes('Session tree'), labels.join());
  assert.ok(labels.includes('Take from Herdr…'));
  assert.ok(labels.includes('Stop agent everywhere…'));
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
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const focusReturned = await page.evaluate(() => document.activeElement?.id === 'message-input');

  // Another browser sees the image too.
  if (!await phone.locator('.agents-panel').isVisible()) await phone.locator('#agents-btn').click();
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
  const refused = page.waitForResponse(response => response.url().endsWith('/api/sessions/delete') && response.request().method() === 'POST');
  await page.locator('.context-menu-item', { hasText: 'Delete' }).click();
  const refusal = await refused;
  assert.equal(refusal.status(), 409);
  const detail = (await refusal.json() as { error: string }).error;
  assert.match(detail, /stop.*before deleting/);
  await until(async () => (await page.locator('#status-text').innerText()).includes(detail), 'the refusal is shown');
  assert.equal((await live()).sessions.some((session) => session.attached?.muxId === third.muxId), true);

  assert.equal(focusReturned, true, 'authoritative dialog closure must return keyboard focus to the composer');
  await phone.close();
  await desk.close();
});

test('either frontend can create, leave zero clients, reattach and stop only by an acknowledged operation', { timeout: 60000 }, async () => {
  const api = context.request;
  const fromPeer = await startMux('equal-lifetime', { PI_ORCHESTRATION_HOST: 'emacs', PI_ORCHESTRATION_ENDPOINT: path.join(work, 'emacs-socket'), PI_ORCHESTRATION_TARGET: '*pi:equal*' });
  const identity = readProcessIdentity(fromPeer.receipt.piPid)!;
  assert.ok(identity);
  await fromPeer.primary.disconnect();
  assert.equal(processIdentityStatus(identity), 'alive', 'creator socket EOF must not stop Pi');
  const attached = await api.post(`${base}/api/live-sessions/attach`, { data: { muxId: fromPeer.muxId } });
  assert.equal(attached.status(), 200);
  const view = (await attached.json() as { session: { id: string; runtime: RuntimeReceipt } }).session;
  assert.equal(view.runtime.piPid, fromPeer.receipt.piPid);
  assert.equal((await api.delete(`${base}/api/live-sessions/${view.id}`)).status(), 200);
  assert.equal(processIdentityStatus(identity), 'alive', 'zero clients must not stop a creator-started root');
  const backToCreator = await peerFor(fromPeer.receipt);
  assert.equal((await backToCreator.request({ type: 'get_state' })).success, true);
  await backToCreator.disconnect();
  assert.equal(processIdentityStatus(identity), 'alive');
  const stoppedPeerRoot = await api.post(`${base}/api/agents/${fromPeer.muxId}/stop`, { data: { confirm: true, operationId: 'peer-origin-stop' } });
  assert.equal(stoppedPeerRoot.status(), 200);
  assert.equal((await stoppedPeerRoot.json() as { receipt: { state: string } }).receipt.state, 'stopped');
  assert.equal(processIdentityStatus(identity), 'dead');

  const created = await api.post(`${base}/api/live-sessions`, { data: { cwd: project, model: 'tau-fx/one', args: [
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', FIXTURE,
  ] } });
  assert.equal(created.status(), 200, await created.text());
  const tauView = (await created.json() as { session: { id: string; runtime: RuntimeReceipt } }).session;
  const receipt = tauView.runtime;
  runtimes.push(receipt);
  const tauIdentity = readProcessIdentity(receipt.piPid)!;
  assert.ok(tauIdentity);
  const peer = await peerFor(receipt);
  assert.equal((await api.delete(`${base}/api/live-sessions/${tauView.id}`)).status(), 200);
  await peer.run('survived the creating Tau view');
  await peer.disconnect();
  assert.equal(processIdentityStatus(tauIdentity), 'alive', 'zero clients must not stop a Tau-created root');
  const reattached = await api.post(`${base}/api/live-sessions/attach`, { data: { muxId: receipt.muxId } });
  assert.equal(reattached.status(), 200);
  const restored = (await reattached.json() as { session: { id: string; runtime: RuntimeReceipt } }).session;
  assert.equal(restored.runtime.piPid, receipt.piPid);
  const again = await peerFor(receipt);
  assert.equal((await again.request({ type: 'get_state' })).success, true);
  const stopped = await api.post(`${base}/api/live-sessions/${restored.id}/stop`, { data: { confirm: true, operationId: 'tau-origin-stop' } });
  assert.equal(stopped.status(), 200, await stopped.text());
  const terminal = (await stopped.json() as { receipt: { state: string } }).receipt;
  assert.equal(terminal.state, 'stopped');
  await again.waitFor(record => record.type === 'pimux_exit', 'stop reaches the equal socket peer');
  assert.equal(processIdentityStatus(tauIdentity), 'dead');
  const repeated = await api.post(`${base}/api/agents/${receipt.muxId}/stop`, { data: { confirm: true, operationId: 'reconcile-stop' } });
  assert.deepEqual((await repeated.json() as { receipt: unknown }).receipt, terminal);
});
