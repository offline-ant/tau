import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser, openUI, session, snapshot } from './ui-correctness-harness.ts';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

for (const state of ['busy', 'dialog'] as const) {
  test(`${state} agent Close sends once, asks nothing and keeps the view until actual acknowledgement`, { timeout: 20000 }, async () => {
    const view = await openUI(browser);
    try {
      await view.page.evaluate(() => { window.confirm = () => { throw new Error('Close must not ask'); }; });
      await view.page.locator('#message-input').fill('unsent draft');
      await view.emit({ type: 'event', sessionId: 'a', event: state === 'busy' ? { type: 'agent_start' }
        : { type: 'extension_ui_request', id: 'blocked-close', method: 'input', title: 'Waiting' } });
      const held = view.hold('/api/live-sessions/a/stop');
      await view.page.locator('.live-tab[data-session-id="a"] .live-tab-close').click();
      await held.called;
      await view.page.locator('.live-tab[data-session-id="a"] .live-tab-close').click();
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1);
      assert.equal(await view.page.locator('#message-input').inputValue(), 'unsent draft');
      await held.resolve({ receipt: { state: 'stopped', muxId: 'mux-a' } });
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0);
      assert.equal(view.requests.some(request => request.method === 'DELETE'), false);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}

for (const failure of ['network', 'identity'] as const) {
  test(`${failure} failure retains the agent and draft and never automatically retries Close`, { timeout: 20000 }, async () => {
    const view = await openUI(browser);
    try {
      await view.page.locator('#message-input').fill('review after uncertain close');
      const held = view.hold('/api/live-sessions/a/stop');
      await view.command('Close agent'); await held.called;
      if (failure === 'network') await held.reject();
      else await held.resolve({ receipt: { state: 'stopped', muxId: 'another-agent' } });
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1);
      assert.equal(await view.page.locator('#message-input').inputValue(), 'review after uncertain close');
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      assert.match(await view.page.locator('#messages').innerText(), /not confirmed|Failed to fetch/);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}

test('Close immediately blocks ordinary Enter and form dispatch without consuming the draft', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill('unsent while closing');
    const held = view.hold('/api/live-sessions/a/stop');
    await view.command('Close agent'); await held.called;
    assert.equal(await view.page.locator('#message-input').isDisabled(), true);
    assert.equal(await view.page.locator('#send-btn').isDisabled(), true);
    await view.page.evaluate(() => {
      document.getElementById('message-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(await view.page.locator('#message-input').inputValue(), 'unsent while closing');
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    await held.reject();
    assert.equal(await view.page.locator('#message-input').isDisabled(), false);
    assert.equal(await view.page.locator('#message-input').inputValue(), 'unsent while closing');
  } finally { await view.close(); }
});

test('Close pauses local queue flush across idle updates while Abort remains available', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill('queued before Close');
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'queue-block', method: 'input', title: 'Waiting' } });
    await view.page.locator('#message-input').press('Enter');
    assert.match(await view.page.locator('#queued-messages').innerText(), /queued before Close/);
    await view.page.locator('#message-input').fill('composer before Close');
    const held = view.hold('/api/live-sessions/a/stop');
    await view.command('Close agent'); await held.called;
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'pimux_dialog_closed', id: 'queue-block' } });
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_settled' } });
    await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a'), 'IDLE WHILE CLOSING', 2) });
    assert.match(await view.page.locator('#queued-messages').innerText(), /queued before Close/);
    assert.equal(await view.page.locator('#message-input').inputValue(), 'composer before Close');
    assert.equal(view.requests.some(request => request.body?.type === 'prompt'), false);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_start' } });
    assert.equal(await view.page.locator('#abort-btn').isDisabled(), false);
    await view.page.locator('#abort-btn').click();
    await view.flush();
    assert.equal(view.requests.some(request => request.body?.type === 'abort' && request.body.sessionId === 'a'), true);
    assert.match(await view.page.locator('#recovered-input').innerText(), /queued before Close/);
    assert.match(await view.page.locator('#recovered-input').innerText(), /composer before Close/);
    assert.equal(view.requests.some(request => request.body?.type === 'prompt'), false);
    await held.resolve({ error: 'Parent task cleanup is still pending' }, 503);
  } finally { await view.close(); }
});

for (const arrival of ['closed-first', 'created-first', 'inventory-first'] as const) {
  test(`peer replacement preserves the selected mux in every browser (${arrival})`, { timeout: 20000 }, async () => {
    const views = [await openUI(browser), await openUI(browser)];
    try {
      for (const view of views) {
        const replacement = session('peer-a', { attached: session('a').attached, sessionFile: '/synthetic/a.jsonl', runtimeContext: session('a').runtimeContext });
        view.live.delete('a'); view.live.set(replacement.id, replacement);
        const closed = { type: 'live_session_closed', sessionId: 'a', reason: 'reconnected' };
        const created = { type: 'live_session_created', session: replacement };
        if (arrival === 'inventory-first') {
          await view.pollInstances();
          await view.page.locator('.live-tab.active[data-session-id="peer-a"]').waitFor();
        }
        await view.emit(arrival === 'created-first' ? created : closed);
        await view.emit(arrival === 'created-first' ? closed : created);
        await view.page.locator('.live-tab.active[data-session-id="peer-a"]').waitFor();
        assert.equal(await view.page.evaluate(() => localStorage.getItem('tau-active-live-session-id')), 'peer-a');
        assert.equal(view.requests.some(request => request.path === '/api/live-sessions/attach'), false, 'peer replacement needs only its ready snapshot');
        assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
      }
    } finally { for (const view of views) await view.close(); }
  });
}

test('manual selection cancels pending peer replacement adoption', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'reconnected' });
    await view.select('b');
    await view.page.locator('#message-input').fill('stay in b');
    const replacement = session('peer-a', { attached: session('a').attached, sessionFile: '/synthetic/a.jsonl', runtimeContext: session('a').runtimeContext });
    view.live.delete('a'); view.live.set(replacement.id, replacement);
    await view.emit({ type: 'live_session_created', session: replacement });
    await view.flush();
    assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'b');
    assert.equal(await view.page.locator('#message-input').inputValue(), 'stay in b');
  } finally { await view.close(); }
});

for (const failureAt of ['while-away', 'after-return'] as const) {
  test(`a named Close failure survives A to B to A (${failureAt})`, { timeout: 20000 }, async () => {
    const view = await openUI(browser);
    try {
      const held = view.hold('/api/live-sessions/a/stop');
      await view.command('Close agent'); await held.called;
      await view.select('b');
      if (failureAt === 'after-return') await view.select('a');
      await held.resolve({ error: 'Parent cleanup failed' }, 503);
      if (failureAt === 'while-away') {
        assert.doesNotMatch(await view.page.locator('#messages').innerText(), /Parent cleanup failed/);
        await view.select('a');
      }
      await view.page.locator('#messages', { hasText: 'Live a: Parent cleanup failed' }).waitFor();
      await view.select('b'); await view.select('a');
      await view.page.locator('#messages', { hasText: 'Live a: Parent cleanup failed' }).waitFor();
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}

for (const result of ['complete', 'failed'] as const) {
  test(`pending Close follows the same mux through peer replacement (${result})`, { timeout: 20000 }, async () => {
    const view = await openUI(browser);
    try {
      const held = view.hold('/api/live-sessions/a/stop');
      await view.command('Close agent'); await held.called;
      const replacement = session('peer-a', { attached: session('a').attached, sessionFile: '/synthetic/a.jsonl', runtimeContext: session('a').runtimeContext });
      view.live.delete('a'); view.live.set(replacement.id, replacement);
      await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'reconnected' });
      await view.emit({ type: 'live_session_created', session: replacement });
      await view.page.locator('.live-tab.active[data-session-id="peer-a"]').waitFor();
      assert.equal(await view.page.locator('#send-btn').isDisabled(), true);
      await view.page.locator('.live-tab[data-session-id="peer-a"] .live-tab-close').click();
      await view.page.evaluate(() => document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
      if (result === 'complete') {
        await held.resolve({ receipt: { state: 'stopped', muxId: 'mux-a' } });
        assert.equal(await view.page.locator('.live-tab[data-session-id="peer-a"]').count(), 0);
      } else {
        await held.resolve({ error: 'Parent cleanup failed' }, 503);
        await view.page.locator('#messages', { hasText: 'Live a: Parent cleanup failed' }).waitFor();
        assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'peer-a');
      }
    } finally { await view.close(); }
  });
}

for (const outcome of ['complete', 'failed'] as const) {
  test(`worker Close retains its unavailable view until parent cleanup is ${outcome}`, { timeout: 20000 }, async () => {
    const worker = session('a', { attached: { ...session('a').attached!, placement: 'worker' } });
    const view = await openUI(browser, [worker, session('b')]);
    try {
      await view.page.locator('#message-input').fill('review worker draft');
      const held = view.hold('/api/live-sessions/a/stop');
      await view.command('Close agent'); await held.called;
      await view.emit({ type: 'live_session_updated', session: { ...worker, runtimeContext: null, inputReady: false } });
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1, 'runtime exit is not parent task completion');
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      if (outcome === 'complete') {
        await held.resolve({ receipt: { state: 'stopped', muxId: 'mux-a' } });
        assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0);
      } else {
        await held.resolve({ error: 'Worker task cleanup failed: native cleanup failed' }, 503);
        assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1);
        assert.match(await view.page.locator('#messages').innerText(), /native cleanup failed/);
        const reconnect = view.hold('/api/live-sessions/a/snapshot');
        await view.select('b'); await view.select('a'); await reconnect.called;
        await reconnect.resolve({ error: 'Worker task cleanup failed: native cleanup failed' }, 503);
        assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'a');
        assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1);
        assert.match(await view.page.locator('#messages').innerText(), /native cleanup failed/);
      }
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      assert.equal(view.requests.some(request => request.method === 'DELETE'), false);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}

test('a snapshot readiness gap does not hide the result of closing the selected agent', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/live-sessions/a/stop');
    await view.command('Close agent'); await held.called;
    await view.emit({ type: 'live_session_updated', session: session('a', { runtimeContext: null, inputReady: false }) });
    await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a'), 'SAME CONVERSATION', 2) });
    await held.reject();
    assert.match(await view.page.locator('#messages').innerText(), /Failed to fetch/);
    assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 1);
    assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
  } finally { await view.close(); }
});

for (const notice of [false, true]) {
  test(`HTTP worker Close preserves ${notice ? 'an orderly notice' : 'abnormal exit diagnostics'} without a WebSocket close event`, { timeout: 20000 }, async () => {
    const worker = session('a', { attached: { ...session('a').attached!, placement: 'worker' } });
    const view = await openUI(browser, [worker, session('b')]);
    try {
      const message = notice ? 'This worker was closed.' : 'Pi process exited (SIGKILL):\nworker stderr: cleanup interrupted';
      const held = view.hold('/api/live-sessions/a/stop');
      await view.command('Close agent'); await held.called;
      await held.resolve({ receipt: { state: 'stopped', muxId: 'mux-a', code: notice ? 0 : null, signal: notice ? null : 'SIGKILL' }, message, notice });
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0);
      assert.equal(await view.page.locator('.live-tab.active').count(), 0, 'the retirement message stays below the worker conversation');
      assert.match(await view.page.locator('#messages').innerText(), /Live a/);
      assert.ok((await view.page.locator('#messages').textContent())?.includes(message));
      assert.equal(await view.page.locator('#messages .error-message').count(), notice ? 0 : 1);
      if (!notice) assert.equal(await view.page.locator('#messages .error-message').isVisible(), true);
      assert.equal(view.requests.filter(request => request.path.endsWith('/stop')).length, 1);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}

for (const transport of ['HTTP', 'WebSocket'] as const) {
  test(`background worker diagnostics remain named and visible through ${transport} retirement`, { timeout: 20000 }, async () => {
    const worker = session('a', { attached: { ...session('a').attached!, placement: 'worker' } });
    const view = await openUI(browser, [worker, session('b')]);
    try {
      await view.select('b');
      await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
      await view.page.locator('#message-input').fill('keep the selected B draft');
      const message = 'Pi process exited (1):\nworker stderr: native cleanup failed';
      const closed = { type: 'live_session_closed', sessionId: 'a', reason: 'worker_task_complete', message, notice: false };
      if (transport === 'HTTP') {
        const held = view.hold('/api/live-sessions/a/stop');
        await view.page.locator('.live-tab[data-session-id="a"] .live-tab-close').click();
        await held.called;
        await held.resolve({ receipt: { state: 'stopped', muxId: 'mux-a', code: 1, signal: null }, message, notice: false });
      } else await view.emit(closed);
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0);
      assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'b');
      assert.equal(await view.page.locator('#message-input').inputValue(), 'keep the selected B draft');
      assert.match(await view.page.locator('#messages .error-message').innerText(), /Live a: Pi process exited \(1\):\s+worker stderr: native cleanup failed/);
      assert.match(await view.page.locator('#status-text').innerText(), /Live a: Pi process exited/);
      await view.emit(closed);
      assert.equal(await view.page.locator('#messages .error-message').count(), 1, 'a late duplicate close event cannot repeat the diagnostic');
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}

test('worker retirement diagnostics stay visible while reading another saved conversation', { timeout: 20000 }, async () => {
  const worker = session('a', { attached: { ...session('a').attached!, placement: 'worker' } });
  const view = await openUI(browser, [worker, session('b')]);
  try {
    await view.stored('owned-b');
    await view.page.locator('#messages', { hasText: 'Read-only: owned-b' }).waitFor();
    await view.emit({ type: 'live_session_closed', sessionId: 'a', message: 'Pi process exited (SIGABRT): worker stderr', notice: false });
    assert.match(await view.page.locator('#messages').innerText(), /Read-only: owned-b/);
    assert.match(await view.page.locator('#messages .error-message').innerText(), /Live a: Pi process exited \(SIGABRT\): worker stderr/);
    assert.equal(await view.page.locator('#message-input').isDisabled(), true);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('a background tab × closes that agent without moving the selected conversation', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.select('b');
    await view.page.locator('#message-input').fill('draft in b');
    await view.page.locator('.live-tab[data-session-id="a"] .live-tab-close').click();
    await view.flush();
    assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'b');
    assert.equal(await view.page.locator('#message-input').inputValue(), 'draft in b');
    assert.deepEqual(view.requests.filter(request => request.path.endsWith('/stop')).map(request => request.path), ['/api/live-sessions/a/stop']);
  } finally { await view.close(); }
});

test('an explicit reattach replaces an unavailable view without cancelling its own selection', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'live_session_updated', session: session('a', { runtimeContext: null, inputReady: false }) });
    await view.emit({ type: 'pimux_agents', agents: [{ muxId: 'mux-a', name: 'Reconnect a', cwd: '/synthetic/project', status: 'idle', detail: null, placement: 'root', host: 'emacs', sessionFile: '/synthetic/a.jsonl', model: null, parentId: null, tabId: null }] });
    const held = view.hold('/api/live-sessions/attach');
    await view.page.locator('#agents-btn').click();
    await view.page.locator('.agent-row[data-mux-id="mux-a"]').click();
    await held.called;
    const replacement = session('a-reconnected', { attached: session('a').attached, sessionFile: '/synthetic/a.jsonl', runtimeContext: session('a').runtimeContext });
    view.live.set(replacement.id, replacement);
    await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'reconnected' });
    await view.emit({ type: 'live_session_created', session: replacement });
    await held.resolve({ session: replacement, attached: true });
    await view.page.locator('.agents-panel').waitFor({ state: 'hidden' });
    assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), replacement.id);
    assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('selecting an unavailable tab adopts the same surviving runtime only after its replacement snapshot', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'live_session_updated', session: session('a', { runtimeContext: null, inputReady: false }) });
    await view.select('b');
    const held = view.hold('/api/live-sessions/a/snapshot');
    await view.select('a'); await held.called;
    const replacement = session('a-restored', { attached: session('a').attached, sessionFile: '/synthetic/a.jsonl', runtimeContext: session('a').runtimeContext });
    view.live.set(replacement.id, replacement);
    await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'reconnected' });
    await view.emit({ type: 'live_session_created', session: replacement });
    await held.resolve(snapshot(replacement, 'RESTORED SAME AGENT', 2));
    await view.page.locator('.live-tab.active[data-session-id="a-restored"]').waitFor();
    assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0);
    assert.equal(view.requests.some(request => request.method === 'POST' && request.path.startsWith('/api/live-sessions')), false, 'snapshot recovery cannot launch');
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('unacknowledged runtime absence retains a selected unavailable tab without creating another agent', { timeout: 20000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.emit({ type: 'live_session_updated', session: session('a', { runtimeContext: null, inputReady: false }) });
    await view.select('b');
    const held = view.hold('/api/live-sessions/a/snapshot');
    await view.select('a'); await held.called;
    await held.resolve({ error: 'Runtime is unavailable; its termination was not acknowledged' }, 503);
    assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'a');
    assert.match(await view.page.locator('#messages').innerText(), /termination was not acknowledged/);
    assert.equal(view.requests.some(request => request.method === 'POST' && request.path.startsWith('/api/live-sessions')), false);
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});

test('remote authoritative closure removes every browser view and saved selection without replay', { timeout: 20000 }, async () => {
  const views = [await openUI(browser), await openUI(browser)];
  try {
    for (const view of views) {
      await view.page.locator('#message-input').fill('keep local input for review');
      await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'pimux_exit:SIGTERM', message: 'This agent was closed.', notice: true });
      await view.emit({ type: 'live_session_created', session: session('a') });
      await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a'), 'STALE OPEN RESPONSE', 3) });
      await view.emit({ type: 'state', liveSessions: [session('a'), session('b')], agents: [] });
      assert.equal(await view.page.locator('.live-tab[data-session-id="a"]').count(), 0, 'late open metadata cannot resurrect a closed agent');
      assert.equal(await view.page.evaluate(() => localStorage.getItem('tau-active-live-session-id')), null);
      assert.match(await view.page.locator('#recovered-input').innerText(), /keep local input for review/);
      assert.equal(view.requests.some(request => request.path.endsWith('/stop') || request.method === 'DELETE'), false);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    }
  } finally { for (const view of views) await view.close(); }
});
