import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser, openUI, session, snapshot } from './ui-correctness-harness.ts';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const original = session('a');
const replacement = () => session('a', { sessionFile: '/synthetic/replacement.jsonl', leafId: 'replacement-leaf' });

test('ordinary leaf progress preserves the opaque context, draft and steering target', async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill('same branch draft');
    const advanced = session('a', { leafId: 'later-message', runtimeContext: original.runtimeContext, isStreaming: true });
    await view.emit({ type: 'live_session_snapshot', ...snapshot(advanced, 'SAME BRANCH', 2) });
    assert.equal(await view.page.locator('#message-input').inputValue(), 'same branch draft');
    assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 0);
    await view.page.locator('#message-input').press('Enter');
    const commands = await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')) as Array<Record<string, unknown>>;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].streamingBehavior, 'steer');
    assert.deepEqual((commands[0].inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
    assert.equal((commands[0].inputContext as Record<string, unknown>).leafId, 'a-leaf', 'an unchanged draft keeps its original UI anchor');
  } finally { await view.close(); }
});

test('a delayed model update cannot send its thinking step to a replacement conversation', async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/rpc', 'set_model');
    await view.page.locator('#model-input').click();
    await view.page.locator('#model-picker-input').fill('synthetic/test-model:high');
    await view.page.locator('#model-picker-save').click();
    await held.called;
    const request = view.requests.find(item => item.body?.type === 'set_model')!;
    assert.deepEqual((request.body?.inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
    await view.emit({ type: 'live_session_snapshot', ...snapshot(replacement(), 'REPLACEMENT', 2) });
    await held.resolve({ success: true, data: { model: { provider: 'synthetic', id: 'test-model' } } });
    await view.flush();
    assert.equal(view.requests.filter(item => item.body?.type === 'set_thinking_level').length, 0);
    assert.doesNotMatch(await view.page.locator('#model-input-label').innerText(), /test-model/);
    assert.equal(await view.page.locator('#messages', { hasText: 'REPLACEMENT' }).count(), 1);
  } finally { await view.close(); }
});

test('an old dialog cannot borrow the current context when metadata adopts another file', async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'old-dialog', method: 'input', title: 'Original approval' } });
    await view.page.locator('#dialog-input').fill('old answer');
    await view.emit({ type: 'live_session_updated', session: replacement() });
    await view.page.locator('#dialog-submit').click();
    await view.page.locator('.dialog-response-notice', { hasText: 'no longer ready' }).waitFor();
    assert.equal(view.requests.filter(item => item.body?.type === 'extension_ui_response').length, 0);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('queue clearing keeps its captured context after the same tab changes conversations', async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/rpc', 'clear_queue');
    await view.command('Clear agent queue everywhere');
    await held.called;
    const request = view.requests.find(item => item.body?.type === 'clear_queue')!;
    assert.deepEqual((request.body?.inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
    await view.emit({ type: 'live_session_snapshot', ...snapshot(replacement(), 'REPLACEMENT', 2) });
    await held.resolve({ success: true, data: { steering: ['original queued text'], followUp: [] },
      recoveryContext: { file: '/synthetic/replacement.jsonl', leafId: 'replacement-leaf' } });
    const recovered = await view.page.locator('#recovered-input').innerText();
    assert.match(recovered, /original queued text/);
    assert.match(recovered, /\/synthetic\/a.jsonl/);
    assert.doesNotMatch(recovered, /replacement.jsonl/);
    assert.equal(await view.page.locator('#message-input').inputValue(), '');
    assert.equal(view.requests.filter(item => item.body?.type === 'clear_queue').length, 1);
  } finally { await view.close(); }
});

test('a dialog answer and Abort both carry the exact context that authorized them', async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'current-dialog', method: 'input', title: 'Current approval' } });
    await view.page.locator('#dialog-input').fill('current answer');
    await view.page.locator('#dialog-submit').click();
    await view.page.locator('.dialog-response-notice', { hasText: 'Waiting for the server' }).waitFor();
    const answer = view.requests.find(item => item.body?.type === 'extension_ui_response')!;
    assert.deepEqual((answer.body?.inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_start' } });
    await view.page.locator('#abort-btn').click();
    await view.flush();
    const abort = view.requests.find(item => item.body?.type === 'abort')!;
    assert.deepEqual((abort.body?.inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
  } finally { await view.close(); }
});

test('tree navigation keeps the context of the rendered tree while its response is delayed', async () => {
  const view = await openUI(browser);
  try {
    await view.page.route('**/api/rpc', route => route.request().postDataJSON()?.type === 'get_tree'
      ? route.fulfill({ json: { success: true, data: { tree: [{ entry: { type: 'message', id: 'target-entry', message: { role: 'user', content: 'Earlier branch' } }, children: [] }], leafId: 'target-entry' } } })
      : route.fallback());
    await view.page.locator('#tree-btn').click();
    const held = view.hold('/api/rpc', 'navigate_tree');
    await view.page.locator('.tree-row').click();
    await held.called;
    const request = view.requests.find(item => item.body?.type === 'navigate_tree')!;
    assert.deepEqual((request.body?.inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
    await view.emit({ type: 'live_session_snapshot', ...snapshot(replacement(), 'REPLACEMENT', 2) });
    await held.resolve({ success: false, error: 'The original branch is no longer selected' });
    assert.equal(await view.page.locator('#messages', { hasText: 'REPLACEMENT' }).count(), 1);
    assert.equal(view.requests.filter(item => item.body?.type === 'navigate_tree').length, 1);
  } finally { await view.close(); }
});

test('an inline rename retains the context in which the name was edited', async () => {
  const view = await openUI(browser);
  try {
    await view.page.route('**/api/sessions/project', route => route.fulfill({ json: { sessions: [
      { filePath: original.sessionFile, file: 'a.jsonl', dir: 'project', name: 'Original name' },
    ] } }));
    await view.page.locator('.project-group .project-header').click();
    await view.page.locator('.session-title', { hasText: 'Original name' }).click({ button: 'right' });
    await view.page.locator('.context-menu-item', { hasText: 'Rename' }).click();
    await view.page.locator('.session-rename-input').fill('Edited original name');
    await view.emit({ type: 'live_session_snapshot', ...snapshot(replacement(), 'REPLACEMENT', 2) });
    await view.page.locator('.session-rename-input').press('Enter');
    await view.flush();
    const request = view.requests.find(item => item.body?.type === 'set_session_name')!;
    assert.equal(request.body?.filePath, original.sessionFile);
    assert.deepEqual((request.body?.inputContext as Record<string, unknown>).runtimeContext, original.runtimeContext);
  } finally { await view.close(); }
});

for (const metadata of [{ runtimeContext: null, inputReady: true }, { runtimeContext: original.runtimeContext, inputReady: false }]) {
  test(`unknown or unready context disables mutation without losing the draft (${JSON.stringify(metadata)})`, async () => {
    const view = await openUI(browser);
    try {
      await view.page.locator('#message-input').fill('keep me for review');
      await view.emit({ type: 'live_session_updated', session: session('a', metadata) });
      assert.equal(await view.page.locator('#message-input').isDisabled(), true);
      assert.equal(await view.page.locator('#send-btn').isDisabled(), true);
      assert.equal(await view.page.locator('#model-input').isDisabled(), true);
      assert.equal(await view.page.locator('#command-btn').isEnabled(), true, 'safe reads and explicit stop remain reachable');
      const kept = `${await view.page.locator('#message-input').inputValue()} ${await view.page.locator('#recovered-input').innerText()}`;
      assert.match(kept, /keep me for review/);
      await view.command('Close agent');
      await view.flush();
      assert.equal(view.requests.filter(item => item.path.endsWith('/stop')).length, 1);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}
