import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';
import { Rig, skip, until, type Reply } from './emacs-share-rig.ts';

/*
 * One Pi, both frontends live: a disposable Emacs daemon on the real
 * configuration (real Pilish and pi-deck, Pi through real pimux, a terminal frame
 * in a private tmux), and the real compiled Tau on private ports in a phone-sized
 * Chromium. Faux providers only.
 *
 *   TAU_EMACS_E2E=1 node --test test/e2e/emacs-share.e2e.ts
 *
 * The tests run in order and build on each other. TAU_E2E_SCREENSHOTS=<dir> keeps
 * screenshots.
 */

const SHOTS = process.env.TAU_E2E_SCREENSHOTS || '';
const OPTIONS = { skip, timeout: 120000 };
const WORDS = Array.from({ length: 150 }, (_, index) => `word${index}`).join(' ');

let rig: Rig;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let main: Reply;
let side: Reply;
let worker: Reply;

const rowOf = (muxId: string) => page.locator(`.agents-panel .agent-row[data-mux-id="${muxId}"]`);
const userMessages = (text: string) => page.locator('.message.user', { hasText: text });
const assistantText = (text: string) => page.locator('.assistant-step-content', { hasText: text });

async function shot(name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function live() {
  return (await (await page.request.get(`${rig.base}/api/live-sessions`)).json()) as { sessions: Reply[] };
}

async function rpc(command: Record<string, unknown>) {
  return (await (await page.request.post(`${rig.base}/api/rpc`, { data: command })).json()) as Reply;
}

async function waitForEmacs(name: string, match: (state: Reply) => boolean, description: string, timeoutMs?: number) {
  return until(async () => { const state = await rig.state(name); return match(state) ? state : null; }, description, timeoutMs);
}

const idleInEmacs = (name: string) => waitForEmacs(name, (state) => state.status === 'idle' && state.deck !== 'working', `${name} idle in Emacs`);

async function phoneSend(text: string) {
  await page.locator('#message-input').fill(text);
  await page.locator('#send-btn').click();
}

async function openAgent(muxId: string) {
  if (!await rowOf(muxId).isVisible()) await page.locator('#agents-btn').click();
  await rowOf(muxId).click();
  await page.locator('.agents-panel').waitFor({ state: 'hidden' });
}

before(async () => {
  if (skip) return;
  rig = new Rig();
  await rig.start();
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium'].find((candidate) => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
  context = await browser.newContext({ ...devices['Pixel 7'], httpCredentials: { username: 'phone', password: rig.password } });
  page = await context.newPage();
});

after(async () => {
  await context?.close();
  await browser?.close();
  if (!rig) return;
  const output = rig.tauOutput;
  const leftovers = await rig.stop();
  assert.deepEqual(leftovers, [], `leftover processes\n${output.slice(-2000)}`);
});

test('overview shows the Emacs agents with status and a real worker under its parent', OPTIONS, async () => {
  main = await rig.call('es-start', `${rig.projects.alpha}/`, 'main');
  side = await rig.call('es-start', `${rig.projects.beta}/`, 'side');
  assert.ok(main.muxId && side.muxId, JSON.stringify({ main, side }));
  await rig.call('es-send', 'main', 'first from emacs');
  await until(async () => (await rig.count('main', 'reply: first from emacs')) === 1, 'first reply in Emacs');
  await idleInEmacs('main');

  // A real `do` worker on the Emacs host, held busy by the faux provider.
  await rig.call('es-send', 'side', 'run worker w1');
  const workerChat = await until(async () => (await rig.call('es-worker', 'side')).buffer, 'worker target');
  const entry = await until(() => rig.discovery().find((record) => record.placement === 'worker' && record.status === 'working'), 'worker in discovery');
  worker = { buffer: workerChat, muxId: entry.muxId, file: entry.session.file };
  assert.equal(entry.parent.id, side.buffer);
  const deck: Reply[] = await rig.call('es-deck');
  assert.equal(deck.find((agent) => agent.buffer === workerChat)?.worker, true, 'pi-deck sees the same worker');

  await page.goto(rig.base);
  await page.locator('.agents-panel').waitFor({ state: 'visible' });
  await rowOf(main.muxId).waitFor();
  await rowOf(side.muxId).waitFor();
  await rowOf(worker.muxId).waitFor();
  assert.match(await rowOf(main.muxId).innerText(), /^main$/m);
  assert.doesNotMatch(await rowOf(side.muxId).innerText(), /pilish-chat/);
  assert.match(await rowOf(worker.muxId).innerText(), /worker [0-9a-f]{8}/);
  assert.match(await rowOf(side.muxId).getAttribute('class') ?? '', /agent-working/);
  assert.match(await rowOf(worker.muxId).getAttribute('class') ?? '', /agent-working/);
  assert.equal(await rowOf(worker.muxId).getAttribute('style'), '--depth:1');
  const order = await page.locator('.agents-panel .agent-row').evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.muxId));
  assert.ok(order.indexOf(side.muxId) === order.indexOf(worker.muxId) - 1, 'the worker follows its parent');

  // Blocked sorts first and reads as blocked in both frontends.
  await rig.call('es-send', 'main', '/fx-select');
  await page.locator(`.agents-panel .agent-row.agent-blocked[data-mux-id="${main.muxId}"]`).waitFor();
  await waitForEmacs('main', (state) => state.deck === 'blocked', 'blocked in pi-deck');
  const first = await page.locator('.agents-panel .agent-row').first().getAttribute('data-mux-id');
  assert.equal(first, main.muxId);
  await shot('overview');
  await rig.call('es-answer', 'main', 'apple');
  await waitForEmacs('main', (state) => state.deck !== 'blocked', 'answered in Emacs');
  await page.locator(`.agents-panel .agent-row.agent-blocked[data-mux-id="${main.muxId}"]`).waitFor({ state: 'detached' });
});

test('worker: a phone cannot replace its session, its prompts count, and the result reaches the parent', OPTIONS, async () => {
  await rowOf(worker.muxId).click();
  await page.locator('.agents-panel').waitFor({ state: 'hidden' });
  await page.locator('.live-tab.active.shared').waitFor();

  // The palette does not offer it, and Pi itself refuses it.
  await page.locator('#command-btn').click();
  await page.locator('.command-item', { hasText: 'Compact' }).waitFor();
  assert.equal(await page.locator('.command-item', { hasText: 'New session' }).count(), 0);
  await page.keyboard.press('Escape');
  const sessionId = await page.locator('.live-tab.active').getAttribute('data-session-id');
  assert.equal((await rpc({ type: 'new_session', sessionId })).data?.cancelled, true);
  const entry = rig.discovery().find((record) => record.muxId === worker.muxId);
  assert.equal(entry.session.file, worker.file, 'the worker stays on its file');

  await page.locator('#send-btn').waitFor();
  await phoneSend('guidance from phone');
  rig.release('w1');
  await assistantText('reply: guidance from phone').waitFor();
  assert.equal(await userMessages('guidance from phone').count(), 1);
  await until(async () => (await rig.count('side', 'tool done: do')) >= 1, 'parent got the worker result', 40000);
  assert.ok((await rig.count('side', 'reply: guidance from phone')) >= 1, 'the worker reply reaches the parent');
  assert.ok((await rig.count('side', 'guidance from phone')) >= 2, 'the parent sees the guidance');
  await idleInEmacs('side');
  await until(() => !rig.discovery().some((record) => record.muxId === worker.muxId), 'worker closed');
  await page.locator('.system-message', { hasText: 'This worker finished' }).waitFor();
  assert.equal(await assistantText('reply: guidance from phone').count(), 1, 'the transcript stays readable');
  await shot('worker-finished');
  await page.locator('#agents-btn').click();
  await page.locator(`.agents-panel .agent-row.agent-done[data-mux-id="${side.muxId}"]`).waitFor();
  await rowOf(worker.muxId).waitFor({ state: 'detached' });
});

test('opening an agent reads its history', OPTIONS, async () => {
  await openAgent(main.muxId);
  await userMessages('first from emacs').waitFor();
  await assistantText('reply: first from emacs').waitFor();
});

test('a phone prompt renders once in both frontends', OPTIONS, async () => {
  await phoneSend('hello from phone');
  await assistantText('reply: hello from phone').waitFor();
  await until(async () => (await rig.count('main', 'reply: hello from phone')) === 1, 'reply in Emacs');
  assert.equal(await rig.count('main', 'hello from phone'), 2, 'prompt and reply, once each');
  assert.equal(await userMessages('hello from phone').count(), 1);
  await idleInEmacs('main');
});

test('a model change in Emacs reaches the phone, and an Emacs prompt streams there live', OPTIONS, async () => {
  await rig.call('es-select-model', 'main', 'tau-fx-slow');
  await waitForEmacs('main', (state) => state.model === 'tau-fx-slow/one', 'model in Emacs');
  await page.locator('#model-input-label', { hasText: 'tau-fx-slow' }).waitFor();

  await rig.call('es-send', 'main', 'stream 150');
  const lengths = new Set<number>();
  await until(async () => {
    const texts = await assistantText('word0').allInnerTexts();
    const text = texts.at(-1) ?? '';
    if (text) lengths.add(text.length);
    return text.includes('word149');
  }, 'streamed text', 30000);
  assert.ok(lengths.size >= 3, `text grew live on the phone: ${[...lengths].join(', ')}`);
  await until(async () => (await assistantText('word149').allInnerTexts()).some((text) => text.trim() === WORDS), 'exact text');
  await until(async () => (await rig.count('main', 'word149')) === 1, 'once in Emacs');
  await idleInEmacs('main');
});

test('a phone model change reaches Emacs', OPTIONS, async () => {
  await page.locator('#model-input').click();
  await page.locator('#model-picker-input').fill('tau-fx/one');
  await page.locator('#model-picker-save').click();
  await waitForEmacs('main', (state) => state.model === 'tau-fx/one', 'model in Emacs');
  await page.locator('#model-input-label', { hasText: 'tau-fx/one' }).waitFor();
});

test('steering works both ways while busy', OPTIONS, async () => {
  // A run started in Emacs, steered from the phone.
  await rig.call('es-send', 'main', 'hold s1 please');
  await page.locator('#abort-btn:not(.hidden)').waitFor();
  await phoneSend('steer from phone');
  await until(() => rig.discovery().find((record) => record.muxId === main.muxId)?.status === 'working', 'busy');
  rig.release('s1');
  await assistantText('reply: steer from phone').waitFor();
  await until(async () => (await rig.count('main', 'reply: steer from phone')) === 1, 'steer reply in Emacs');
  assert.equal(await rig.count('main', 'steer from phone'), 2);
  assert.equal(await userMessages('steer from phone').count(), 1);
  await idleInEmacs('main');

  // A run started on the phone, steered from Emacs.
  await phoneSend('hold s2 please');
  await waitForEmacs('main', (state) => state.deck === 'working', 'phone run working in pi-deck');
  await rig.call('es-send', 'main', 'steer from emacs');
  rig.release('s2');
  await assistantText('reply: steer from emacs').waitFor();
  await until(async () => (await rig.count('main', 'reply: steer from emacs')) === 1, 'steer reply in Emacs');
  assert.equal(await rig.count('main', 'steer from emacs'), 2);
  assert.equal(await userMessages('steer from emacs').count(), 1);
  await idleInEmacs('main');
  await shot('steering');
});

test('dialogs answered on one side clear on the other', OPTIONS, async () => {
  // A tool's dialog inside a phone-started run, answered on the phone.
  await phoneSend('ask with a tool');
  await waitForEmacs('main', (state) => state.deck === 'blocked' && state.dialogs.length === 1 && state.widgets.length === 1, 'dialog in Emacs');
  await page.locator('#agents-btn[data-urgency="blocked"]').waitFor();
  await page.locator('.dialog-option', { hasText: 'red' }).click();
  await waitForEmacs('main', (state) => state.dialogs.length === 0 && state.widgets.length === 0, 'dialog cleared in Emacs');
  await until(async () => (await rig.count('main', 'tool done: fx_ask')) === 1, 'run continued');
  await idleInEmacs('main');

  // A command's dialog outside any run, answered in Emacs.
  await rig.call('es-send', 'main', '/fx-select');
  await page.locator('.dialog-title', { hasText: 'Pick a fruit' }).waitFor();
  await rig.call('es-answer', 'main', 'pear');
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });
  await waitForEmacs('main', (state) => state.dialogs.length === 0, 'closed in Emacs');

  // A dialog survives a phone reload, once, and the answer from there counts.
  await rig.call('es-send', 'main', '/fx-select');
  await page.locator('.dialog-title', { hasText: 'Pick a fruit' }).waitFor();
  await page.reload();
  await page.locator('.dialog-title', { hasText: 'Pick a fruit' }).waitFor();
  await page.locator('.dialog-option', { hasText: 'apple' }).click();
  await waitForEmacs('main', (state) => state.dialogs.length === 0 && state.widgets.length === 0, 'answered after the reload');
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });

  // A tool's dialog, answered in Emacs.
  await rig.call('es-send', 'main', 'ask with a tool again');
  await page.locator('.dialog-title', { hasText: 'Pick a colour' }).waitFor();
  await rig.call('es-answer', 'main', 'blue');
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });
  await until(async () => (await rig.count('main', 'tool done: fx_ask')) === 2, 'second run continued');
  await idleInEmacs('main');
});

test('reloading the phone mid-stream recovers the exact text', OPTIONS, async () => {
  await rig.call('es-select-model', 'main', 'tau-fx-slow');
  await page.locator('#model-input-label', { hasText: 'tau-fx-slow' }).waitFor();
  await phoneSend('stream 150');
  await assistantText('word3').last().waitFor();
  await page.reload();
  await assistantText('word1 ').last().waitFor();
  await until(async () => (await assistantText('word149').allInnerTexts()).filter((text) => text.trim() === WORDS).length >= 1, 'exact text after reload', 30000);
  await idleInEmacs('main');
  assert.equal((await assistantText(' word149').allInnerTexts()).filter((text) => text.includes('word149')).length, 2, 'this reply and the earlier one, once each');
  await rig.call('es-select-model', 'main', 'one [tau-fx]');
  await page.locator('#model-input-label', { hasText: 'tau-fx/one' }).waitFor();
});

test('the phone keeps working while Emacs is stalled, and Emacs then catches up', OPTIONS, async () => {
  await rig.keys('M-x');
  await until(async () => (await rig.call('es-minibuffer')).open, 'minibuffer open');
  const stall = rig.call('es-stall', 10);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const started = Date.now();
  await phoneSend('during stall one');
  await assistantText('reply: during stall one').waitFor();
  await phoneSend('during stall two');
  await assistantText('reply: during stall two').waitFor();
  const quick = Date.now() - started;
  await phoneSend('big reply please');
  await assistantText('BIG-END').waitFor({ timeout: 60000 });
  const elapsed = Date.now() - started;
  await stall;
  console.log(`during the stall: two prompts took ${quick} ms, a 420 KB reply drew in ${elapsed} ms`);
  assert.ok(quick < 5000, 'prompts are not held back by Emacs');

  await until(async () => (await rig.count('main', 'BIG-END')) === 1, 'big reply in Emacs', 60000);
  await idleInEmacs('main');
  assert.equal(await rig.count('main', 'reply: during stall one'), 1);
  assert.equal(await rig.count('main', 'reply: during stall two'), 1);
  const state = await rig.state('main');
  assert.ok(state.records.includes('pimux_gap'), `Emacs saw the gap: ${state.records.join(',')}`);
  assert.equal((await rig.call('es-minibuffer')).open, true);
  await rig.keys('C-g');
  await until(async () => !(await rig.call('es-minibuffer')).open, 'minibuffer closed');
  await rig.call('es-send', 'main', 'after the stall');
  await assistantText('reply: after the stall').waitFor();
  await idleInEmacs('main');
});

test('a new session from the phone is adopted in Emacs in the same process', OPTIONS, async () => {
  await rig.call('es-draft', 'main', 'unsent draft');
  const before = await rig.state('main');
  await page.locator('#command-btn').click();
  await page.locator('.command-item', { hasText: 'New session' }).click();
  await userMessages('hello from phone').waitFor({ state: 'detached' });
  const after = await waitForEmacs('main', (state) => state.file !== before.file, 'session changed in Emacs');
  assert.equal(after.pid, before.pid, 'same process');
  assert.equal(after.draft, 'unsent draft');
  assert.equal(after.deckFile, after.file);
  assert.equal(await rig.count('main', 'hello from phone'), 0, 'old transcript gone');
  await until(() => { try { return fs.readFileSync(rig.stateFile, 'utf8').includes(path.basename(after.file)); } catch { return false; } }, 'pi-deck state saved', 15000);
  await until(() => rig.discovery().find((record) => record.muxId === main.muxId)?.session?.file === after.file, 'discovery follows');

  await phoneSend('in the new session');
  await until(async () => (await rig.count('main', 'reply: in the new session')) === 1, 'prompt lands in the new session');
  assert.ok(fs.readFileSync(after.file, 'utf8').includes('in the new session'));
  assert.ok(!fs.readFileSync(before.file, 'utf8').includes('in the new session'));
  await rig.call('es-draft', 'main', '');
  await idleInEmacs('main');
  main.file = after.file;
});

test('Tau cannot delete a live file or open a second writer, and renames go through Pi', OPTIONS, async () => {
  for (const [name, file] of [['attached', main.file], ['unattached', side.file]]) {
    const deleted = await page.request.post(`${rig.base}/api/sessions/delete`, { data: { filePath: file } });
    assert.equal(deleted.status(), 409, `${name} delete`);
    assert.ok(fs.existsSync(file));
  }

  const renamed = await rpc({ type: 'set_session_name', filePath: side.file, name: 'side renamed' });
  assert.equal(renamed.success, true, JSON.stringify(renamed));
  await until(() => rig.discovery().find((record) => record.muxId === side.muxId)?.session?.name === 'side renamed', 'rename reached the running Pi');

  const tabs = (await live()).sessions.length;
  const create = await page.request.post(`${rig.base}/api/live-sessions`, { data: { cwd: rig.projects.beta, args: ['--session', side.file] } });
  assert.ok(create.status() >= 400, 'session-opening args are refused');
  const resumed = await page.request.post(`${rig.base}/api/live-sessions/resume`, { data: { filePath: side.file, force: true } });
  assert.equal(resumed.status(), 200, await resumed.text());
  assert.equal((await resumed.json()).attached, true, 'force attaches, it does not spawn');
  assert.equal((await live()).sessions.length, tabs + 1);
  assert.equal(rig.discovery().filter((record) => record.session?.file === side.file).length, 1);
});

test('restarting Tau leaves the Emacs agents running, and the phone reattaches', OPTIONS, async () => {
  const before = await rig.state('main');
  await rig.stopTau();
  assert.equal((await rig.call('es-alive', 'main')).alive, true);
  assert.equal((await rig.call('es-alive', 'side')).alive, true);
  await rig.call('es-send', 'main', 'while tau is down');
  await until(async () => (await rig.count('main', 'reply: while tau is down')) === 1, 'Emacs works alone');
  await rig.startTau();
  // The phone keeps its page, reconnects and returns to the agent by itself.
  await assistantText('reply: while tau is down').waitFor({ timeout: 30000 });
  assert.equal((await rig.state('main')).pid, before.pid);
  // A send before the socket is back keeps the draft, so tapping again works.
  await page.locator('#message-input').fill('back after the restart');
  await until(async () => {
    await page.locator('#send-btn').click();
    return (await page.locator('#message-input').inputValue()) === '';
  }, 'phone reconnected and sent', 30000);
  await until(async () => (await rig.count('main', 'reply: back after the restart')) === 1, 'phone drives Emacs again');
  await idleInEmacs('main');
});

test('closing the agent in pi-deck shows a clear message in Tau', OPTIONS, async () => {
  const piPid = rig.discovery().find((record) => record.muxId === main.muxId).piPid;
  await rig.call('es-stop', 'main');
  await page.locator('.system-message', { hasText: 'This agent was closed in emacs.' }).waitFor();
  await assistantText('reply: back after the restart').waitFor();
  await shot('agent-closed');
  await until(() => !rig.discovery().some((record) => record.muxId === main.muxId), 'discovery removed');
  await until(() => { try { process.kill(piPid, 0); return false; } catch { return true; } }, 'Pi exited');
  assert.equal((await rig.call('es-alive', 'side')).alive, true, 'the other agent is untouched');
  await page.locator('#agents-btn').click();
  await rowOf(side.muxId).waitFor();
  assert.equal(await rowOf(main.muxId).count(), 0);
});
