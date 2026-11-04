import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser, openUI, session, snapshot } from './ui-correctness-harness.ts';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

for (const failure of [false, true]) {
  test(`an obsolete initial follow ${failure ? 'failure' : 'success'} cannot replace a newer live view`, async () => {
    const view = await openUI(browser);
    try {
      const held = view.hold('/api/sessions/project/owned-a.jsonl');
      await view.stored('owned-a'); await held.called;
      await view.select('b'); await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
      if (failure) await held.reject(); else await held.resolve({ entries: [{ type: 'message', message: { role: 'user', content: 'STALE FOLLOW' } }], offset: 1 });
      await view.flush();
      assert.match(await view.page.locator('#messages').innerText(), /Live b/);
      assert.doesNotMatch(await view.page.locator('#messages').innerText(), /STALE|Failed|Read-only/);
      assert.equal(await view.page.evaluate(() => Reflect.get(window, 'fixturePollCount')()), 0);
    } finally { await view.close(); }
  });
}

test('an obsolete failed poll cannot stop or render into a newer follower', async () => {
  const view = await openUI(browser);
  try {
    await view.stored('owned-a'); await view.page.locator('#messages', { hasText: 'Read-only: owned-a' }).waitFor();
    const held = view.hold('/api/sessions/project/owned-a.jsonl');
    await view.page.evaluate(() => Reflect.get(window, 'fixturePoll')()); await held.called;
    await view.stored('owned-b'); await view.page.locator('#messages', { hasText: 'Read-only: owned-b' }).waitFor();
    await held.reject(); await view.flush();
    assert.match(await view.page.locator('#messages').innerText(), /Read-only: owned-b/);
    assert.doesNotMatch(await view.page.locator('#messages').innerText(), /Stopped|Failed/);
    assert.equal(await view.page.evaluate(() => Reflect.get(window, 'fixturePollCount')()), 1);
    const before = view.requests.filter(item => item.path.endsWith('/owned-b.jsonl')).length;
    await view.page.evaluate(() => Reflect.get(window, 'fixturePoll')()); await view.flush();
    assert.equal(view.requests.filter(item => item.path.endsWith('/owned-b.jsonl')).length, before + 1);
  } finally { await view.close(); }
});

for (const failure of [false, true]) {
  test(`A -> B -> A discards the first A snapshot's late ${failure ? 'failure' : 'success'}`, async () => {
    const view = await openUI(browser);
    try {
      const held = view.hold('/api/live-sessions/a/snapshot');
      await view.select('a'); await held.called;
      await view.select('b'); await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
      await view.select('a'); await view.page.locator('#messages', { hasText: 'Live a' }).waitFor();
      if (failure) await held.reject(); else await held.resolve(snapshot(session('a'), 'STALE FIRST A', 20));
      await view.flush();
      assert.match(await view.page.locator('#messages').innerText(), /Live a/);
      assert.doesNotMatch(await view.page.locator('#messages').innerText(), /STALE|Failed/);
      assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'a');
    } finally { await view.close(); }
  });
}

for (const failure of [false, true]) {
  test(`a stored resume's late ${failure ? 'failure' : 'success'} does not steal a newer selection`, async () => {
    const view = await openUI(browser);
    try {
      const held = view.hold('/api/live-sessions/resume');
      await view.stored('resume'); await held.called;
      await view.select('b'); await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
      if (failure) await held.resolve({ error: 'STALE RESUME ERROR' }, 409);
      else await held.resolve({ session: session('resumed') });
      await view.flush();
      assert.match(await view.page.locator('#messages').innerText(), /Live b/);
      assert.doesNotMatch(await view.page.locator('#messages').innerText(), /STALE|Failed|Resuming/);
      assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'b');
      if (!failure) assert.equal(await view.page.locator('.live-tab[data-session-id="resumed"]').count(), 1, 'a successful server open is retained as a background tab');
    } finally { await view.close(); }
  });
}

test('a late reused resume cannot roll back the selected tab’s context or quarantine its newer draft', async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/live-sessions/resume');
    await view.stored('resume'); await held.called;
    await view.select('b'); await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
    await view.page.locator('#message-input').fill('draft for the newer B context');
    await held.resolve({ reused: true, session: session('b', { cwd: '/stale/project', sessionFile: '/stale/conversation.jsonl', leafId: 'stale-leaf' }) });
    assert.match(await view.page.locator('.live-tab.active').getAttribute('title') || '', /\/synthetic\/project/);
    assert.equal(await view.page.locator('#message-input').inputValue(), 'draft for the newer B context');
    assert.equal(await view.page.locator('#recovered-input .queued-msg').count(), 0);
    assert.match(await view.page.locator('#messages').innerText(), /Live b/);
  } finally { await view.close(); }
});

test('choosing the launcher retires a pending follow, even if the live id did not change', async () => {
  const view = await openUI(browser);
  try {
    const held = view.hold('/api/sessions/project/owned-a.jsonl');
    await view.stored('owned-a'); await held.called;
    await view.page.locator('.mode-link-launcher').click();
    await held.resolve({ entries: [], offset: 0 }); await view.flush();
    assert.equal(await view.page.locator('#launcher').evaluate(element => element.classList.contains('hidden')), false);
    assert.doesNotMatch(await view.page.locator('#messages').innerText(), /Read-only/);
    assert.equal(await view.page.evaluate(() => Reflect.get(window, 'fixturePollCount')()), 0);
  } finally { await view.close(); }
});

for (const manualChoice of [false, true]) {
  test(`reconnecting ${manualChoice ? 'does not override a newer manual choice' : 'reattaches the former agent without starting it again'}`, async () => {
    const view = await openUI(browser);
    try {
      await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'server_shutdown' });
      await view.page.locator('.live-tab.active[data-session-id="b"]').waitFor();
      if (manualChoice) await view.select('b');
      const attach = manualChoice ? null : view.hold('/api/live-sessions/attach');
      const agent = { muxId: 'mux-a', name: 'Former agent', cwd: '/synthetic/project', status: 'idle', detail: null,
        placement: 'root', host: 'emacs', sessionFile: '/synthetic/a.jsonl', model: null, parentId: null, tabId: null };
      await view.emit({ type: 'state', liveSessions: [session('b')], agents: [agent] });
      if (attach) {
        const restored = session('a-restored', { attached: session('a').attached, sessionFile: '/synthetic/a.jsonl', runtimeContext: session('a').runtimeContext });
        view.live.delete('a'); view.live.set(restored.id, restored);
        await attach.called; await attach.resolve({ session: restored });
        await view.page.locator('.live-tab.active[data-session-id="a-restored"]').waitFor();
      } else {
        await view.flush();
        assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'b');
        assert.equal(view.requests.filter(item => item.path === '/api/live-sessions/attach').length, 0);
      }
      assert.equal(view.requests.some(item => item.method === 'POST' && ['/api/live-sessions', '/api/live-sessions/resume'].includes(item.path)), false);
    } finally { await view.close(); }
  });
}
