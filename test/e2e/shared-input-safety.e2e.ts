import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser, openUI, session, snapshot } from './ui-correctness-harness.ts';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4wAAAABJRU5ErkJggg==', 'base64');

for (const change of ['file', 'leaf'] as const) {
  test(`an authoritative ${change} change quarantines text, images and a local queue without resending`, async () => {
    const view = await openUI(browser);
    try {
      await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'pending', method: 'input', title: 'Approval' } });
      await view.page.locator('#message-input').fill('local queued instruction');
      await view.page.locator('#message-input').press('Enter');
      await view.page.locator('.queued-msg', { hasText: 'local queued instruction' }).waitFor();
      await view.page.locator('#message-input').fill('draft for original branch');
      await view.page.locator('#image-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png });
      await view.page.locator('#image-previews img').waitFor();
      assert.equal(await view.page.locator('#message-input').inputValue(), 'draft for original branch', 'the draft must be present before publishing the authoritative replacement');
      const moved = session('a', change === 'file' ? { sessionFile: '/synthetic/other.jsonl' } : { leafId: 'other-leaf' });
      await view.emit({ type: 'live_session_snapshot', ...snapshot(moved, 'NEW CONTEXT', 2) });
      await view.page.locator('#messages', { hasText: 'NEW CONTEXT' }).waitFor();
      assert.equal(await view.page.locator('#message-input').inputValue(), '');
      assert.equal(await view.page.locator('#image-previews img').count(), 0);
      assert.match(await view.page.locator('#recovered-input').innerText(), /local queued instruction/);
      assert.match(await view.page.locator('#recovered-input').innerText(), /draft for original branch/);
      assert.match(await view.page.locator('#recovered-input').innerText(), /a-leaf/);
      assert.equal(view.requests.filter(item => item.body?.type === 'prompt').length, 0);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
      await view.page.getByRole('button', { name: 'Reuse', exact: true }).click();
      assert.match(await view.page.locator('#message-input').inputValue(), /local queued instruction/);
      assert.match(await view.page.locator('#message-input').inputValue(), /draft for original branch/);
      assert.equal(await view.page.locator('#image-previews img').count(), 1);
      assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 0);
      const confirmations = await view.page.evaluate(() => Reflect.get(window, 'fixtureConfirmations')) as string[];
      assert.ok(confirmations.some(text => text.includes('a-leaf') && text.includes('currently selected conversation')));
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), [], 'reuse only edits the composer');
    } finally { await view.close(); }
  });
}

test('uncertain WebSocket input stays with its original file after a context replacement', async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill('may already have reached Pi');
    await view.page.locator('#message-input').press('Enter');
    const sent = await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')) as Array<{ id: string }>;
    assert.equal(sent.length, 1);
    await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a', { sessionFile: '/synthetic/new.jsonl' }), 'NEW', 2) });
    await view.emit({ type: 'response', id: sent[0].id, success: false, error: 'old failure' });
    assert.equal(await view.page.locator('#message-input').inputValue(), '');
    assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 1);
    assert.match(await view.page.locator('#recovered-input').innerText(), /\/synthetic\/a.jsonl/);
    assert.match(await view.page.locator('#recovered-input').innerText(), /may already have reached Pi/);
    assert.equal((await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')) as unknown[]).length, 1);
  } finally { await view.close(); }
});

test('clearing the global queue recovers every acknowledged entry once, only for the requester and its original context', async () => {
  const first = await openUI(browser), second = await openUI(browser);
  try {
    const queue = { type: 'event', sessionId: 'a', event: { type: 'queue_update', steering: ['other frontend steering'], followUp: ['another frontend follow-up'] } };
    await first.emit(queue); await second.emit(queue);
    const held = first.hold('/api/rpc', 'clear_queue');
    await first.command('Clear agent queue everywhere'); await held.called;
    const request = first.requests.filter(item => item.body?.type === 'clear_queue').at(-1)!;
    assert.equal(request.body?.type, 'clear_queue'); assert.equal(request.body?.confirmGlobal, true);
    await first.select('b'); await first.page.locator('#messages', { hasText: 'Live b' }).waitFor();
    const cleared = { type: 'event', sessionId: 'a', event: { type: 'shared_queue_cleared' } };
    await first.emit(cleared); await second.emit(cleared);
    await held.resolve({ success: true, data: { steering: ['other frontend steering'], followUp: ['another frontend follow-up'] }, recoveryContext: { file: '/synthetic/a.jsonl', leafId: 'a-leaf', generation: 1 } });
    await first.page.locator('#recovered-input .queued-msg').waitFor();
    assert.equal(await first.page.locator('#message-input').inputValue(), '');
    const recovery = await first.page.locator('#recovered-input').innerText();
    assert.match(recovery, /other frontend steering/); assert.match(recovery, /another frontend follow-up/); assert.match(recovery, /\/synthetic\/a.jsonl/);
    assert.equal(await first.page.locator('#recovered-input .queued-msg').count(), 1);
    assert.equal(await second.page.locator('#recovered-input .queued-msg').count(), 0);
    assert.equal(await second.page.locator('#queued-messages .queued-msg').count(), 0);
    const confirmations = await first.page.evaluate(() => Reflect.get(window, 'fixtureConfirmations')) as string[];
    assert.match(confirmations[0], /ALL.*EVERY frontend/);
    assert.match(confirmations[0], /Only this browser/);
    await first.emit(cleared); await first.flush();
    assert.equal(await first.page.locator('#recovered-input .queued-msg').count(), 1);
    assert.deepEqual(await first.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await first.close(); await second.close(); }
});

test('a lost clear_queue acknowledgement never fabricates recovery or retries the destructive command', async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/rpc', 'clear_queue');
    await view.command('Clear agent queue everywhere'); await held.called;
    await held.reject();
    await view.page.locator('#status-text', { hasText: 'nothing was resent' }).waitFor();
    assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 0);
    assert.equal(view.requests.filter(item => item.body?.type === 'clear_queue').length, 1);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('Abort explains its global effects, clears the queue and keeps returned text for review without stopping the agent', async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_start' } });
    const clear = view.hold('/api/rpc', 'clear_queue');
    const abort = view.hold('/api/rpc', 'abort');
    await view.page.locator('#abort-btn').click();
    await Promise.all([clear.called, abort.called]);
    assert.equal(view.requests.filter(item => item.body?.type === 'abort').length, 1, 'Abort must reach Pi even while clear_queue has no acknowledgement');
    await abort.resolve({ success: true });
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_settled' } });
    await clear.resolve({ success: true, data: { steering: ['global queued text'], followUp: [] }, recoveryContext: { file: '/synthetic/a.jsonl', leafId: 'a-leaf' } });
    await view.flush();
    assert.match(await view.page.locator('#recovered-input').innerText(), /global queued text/);
    assert.equal(await view.page.locator('#message-input').inputValue(), '');
    assert.equal(view.requests.some(item => item.path.endsWith('/stop')), false);
    const confirmations = await view.page.evaluate(() => Reflect.get(window, 'fixtureConfirmations')) as string[];
    assert.match(confirmations[0], /EVERY frontend.*ALL queued/);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('idle agents expose global Stop separately from tab disconnect, regardless of who created them', async () => {
  const view = await openUI(browser);
  try {
    assert.equal(await view.page.locator('#tree-btn').evaluate(element => element.classList.contains('hidden')), false, 'advertised tree capability is available on a shared agent');
    await view.command('Stop agent everywhere'); await view.flush();
    const stops = view.requests.filter(item => item.path.endsWith('/stop'));
    assert.equal(stops.length, 1); assert.equal(stops[0].method, 'POST'); assert.equal(stops[0].body?.confirm, true);
    assert.equal(typeof stops[0].body?.operationId, 'string');
    assert.equal(view.requests.some(item => item.body?.type === 'abort'), false);
    const confirmations = await view.page.evaluate(() => Reflect.get(window, 'fixtureConfirmations')) as string[];
    assert.match(confirmations[0], /every frontend.*idle/);
    await view.page.locator('.live-tab[data-session-id="a"] .live-tab-close').click(); await view.flush();
    assert.equal(view.requests.filter(item => item.path.endsWith('/stop')).length, 1, 'closing never sends stop');
    assert.equal(view.requests.filter(item => item.method === 'DELETE' && item.path === '/api/live-sessions/a').length, 1);
  } finally { await view.close(); }
});

test('ambiguous runtime editor text is explicit, context-bound recovery and duplicate notices do not append it again', async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill('my draft');
    const event = { type: 'event', sessionId: 'a', event: { type: 'pimux_editor_text', noticeId: 1, text: 'runtime editor text', sessionFile: '/synthetic/older.jsonl' } };
    await view.emit(event); await view.emit(event);
    assert.equal(await view.page.locator('#message-input').inputValue(), 'my draft');
    assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 1);
    assert.match(await view.page.locator('#recovered-input').innerText(), /older.jsonl · leaf unknown/);
    assert.doesNotMatch(await view.page.locator('#recovered-input').innerText(), /a-leaf/);
    assert.equal((await view.page.locator('#recovered-input').innerText()).split('runtime editor text').length, 2);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('an image still being read when the context changes is kept under its original identity', async () => {
  const view = await openUI(browser);
  try {
    await view.page.evaluate(() => {
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) {
        const loaded = this.onload;
        this.onload = event => { Reflect.set(window, 'fixtureReleaseImage', () => loaded?.call(this, event)); };
        read.call(this, file);
      };
    });
    await view.page.locator('#image-input').setInputFiles({ name: 'delayed.png', mimeType: 'image/png', buffer: png });
    await view.page.waitForFunction(() => typeof Reflect.get(window, 'fixtureReleaseImage') === 'function');
    await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a', { leafId: 'new-branch' }), 'NEW BRANCH', 2) });
    await view.page.evaluate(() => Reflect.get(window, 'fixtureReleaseImage')());
    await view.page.locator('#recovered-input .queued-msg').waitFor();
    assert.match(await view.page.locator('#recovered-input').innerText(), /a-leaf/);
    assert.equal(await view.page.locator('#image-previews img').count(), 0);
    await view.page.getByRole('button', { name: 'Reuse', exact: true }).click();
    assert.equal(await view.page.locator('#image-previews img').count(), 1);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('a lost queued-prompt acknowledgement keeps the ordered dispatch locked without replaying either instruction', async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'queue-lock', method: 'input', title: 'Approval' } });
    for (const text of ['first ordered instruction', 'second ordered instruction']) {
      await view.page.locator('#message-input').fill(text); await view.page.locator('#message-input').press('Enter');
    }
    const first = view.hold('/api/rpc', 'prompt');
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'pimux_dialog_closed', id: 'queue-lock' } });
    await first.called; await first.reject();
    await view.page.locator('#queued-messages', { hasText: 'Delivery uncertain' }).waitFor();
    await view.emit({ type: 'live_session_updated', session: session('a') }); await view.flush();
    assert.equal(view.requests.filter(item => item.body?.type === 'prompt').length, 1);
    assert.match(await view.page.locator('#queued-messages').innerText(), /first ordered instruction/);
    assert.match(await view.page.locator('#queued-messages').innerText(), /second ordered instruction/);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a', { leafId: 'other' }), 'MOVED', 2) });
    assert.match(await view.page.locator('#recovered-input').innerText(), /first ordered instruction/);
    assert.match(await view.page.locator('#recovered-input').innerText(), /second ordered instruction/);
    assert.equal(view.requests.filter(item => item.body?.type === 'prompt').length, 1);
  } finally { await view.close(); }
});

test('declining global actions leaves the agent, its queue and the composer untouched', async () => {
  const view = await openUI(browser);
  try {
    await view.page.evaluate(() => { window.confirm = () => false; });
    await view.page.locator('#message-input').fill('untouched draft');
    await view.command('Clear agent queue everywhere');
    await view.command('Stop agent everywhere');
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_start' } });
    await view.page.locator('#abort-btn').click(); await view.flush();
    assert.equal(view.requests.some(item => ['clear_queue', 'abort'].includes(String(item.body?.type)) || item.path.endsWith('/stop') || item.method === 'DELETE'), false);
    assert.equal(await view.page.locator('#message-input').inputValue(), 'untouched draft');
    assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 0);
  } finally { await view.close(); }
});

test('an incomplete global-stop receipt cannot claim the agent stopped or remove its tab', async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/live-sessions/a/stop');
    await view.command('Stop agent everywhere'); await held.called;
    await held.resolve({ receipt: { state: 'stopping' } });
    await view.page.locator('#status-text', { hasText: 'not confirmed' }).waitFor();
    assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1);
    assert.equal(view.requests.some(item => item.method === 'DELETE'), false);
  } finally { await view.close(); }
});

test('shared dialogs close only on authoritative mux closure, not an answer acknowledgement, settlement or stale snapshot', async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'authoritative', method: 'input', title: 'Shared approval' } });
    await view.page.locator('#dialog-input').fill('answer');
    const answer = view.hold('/api/rpc', 'extension_ui_response');
    await view.page.locator('#dialog-submit').click(); await answer.called;
    await answer.resolve({ success: true });
    await view.page.locator('.dialog-response-notice', { hasText: 'Waiting for the server' }).waitFor();
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_settled' } });
    await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a'), 'OLD SNAPSHOT', 1) });
    assert.equal(await view.page.locator('#dialog-container .dialog').count(), 1);
    assert.equal(await view.page.locator('#dialog-submit').isDisabled(), true);
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'pimux_dialog_closed', id: 'authoritative' } });
    assert.equal(await view.page.locator('#dialog-container .dialog').count(), 0);
    const answers = view.requests.filter(item => item.body?.type === 'extension_ui_response');
    assert.equal(answers.length, 1);
    assert.equal(answers[0].body?.value, 'answer');
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});
