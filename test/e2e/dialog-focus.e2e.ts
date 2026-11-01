import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser, openUI, session, snapshot } from './ui-correctness-harness.ts';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });
const request = (id: string) => ({ type: 'extension_ui_request', id, method: 'select', title: id, options: ['first', 'second'] });
const event = (value: unknown) => ({ type: 'event', sessionId: 'a', event: value });
type View = Awaited<ReturnType<typeof openUI>>;
async function close(view: View, mode: 'closed' | 'snapshot', remaining: ReturnType<typeof request>[] = []) {
  if (mode === 'closed') await view.emit(event({ type: 'pimux_dialog_closed', id: 'old-dialog' }));
  else await view.emit({ type: 'live_session_snapshot', ...snapshot(session('a'), 'Authoritative history', 2), dialogs: remaining });
}
async function focused(view: View) {
  return view.page.evaluate(() => ({ id: document.activeElement?.id, text: document.activeElement?.textContent }));
}

for (const mode of ['closed', 'snapshot'] as const) {
  test(`${mode} resolution returns focus after the answer control was disabled`, async () => {
    const view = await openUI(browser);
    try {
      await view.emit(event({ ...request('old-dialog'), method: 'input' }));
      await view.page.locator('#dialog-input').fill('answer');
      const answer = view.hold('/api/rpc', 'extension_ui_response');
      await view.page.locator('#dialog-submit').click(); await answer.called;
      await answer.resolve({ success: true });
      assert.equal(await view.page.locator('.dialog').count(), 1, 'answer acknowledgement is not authoritative closure');
      assert.equal(await view.page.locator('#dialog-submit').isDisabled(), true);
      await close(view, mode);
      assert.equal(await view.page.locator('.dialog').count(), 0);
      assert.equal((await focused(view)).id, 'message-input');
      assert.equal(view.requests.filter(item => item.body?.type === 'extension_ui_response').length, 1);
    } finally { await view.close(); }
  });

  test(`${mode} resolution does not steal focus from a control selected while the answer was pending`, async () => {
    const view = await openUI(browser);
    try {
      await view.emit(event(request('old-dialog')));
      const answer = view.hold('/api/rpc', 'extension_ui_response');
      await view.page.keyboard.press('Enter'); await answer.called;
      await view.page.locator('#command-btn').focus();
      await answer.resolve({ success: true });
      await close(view, mode);
      assert.equal((await focused(view)).id, 'command-btn');
      assert.equal(await view.page.locator('.dialog').count(), 0);
    } finally { await view.close(); }
  });

  test(`${mode} resolution yields to the next authoritative dialog and ignores repeated old closure`, async () => {
    const view = await openUI(browser);
    try {
      await view.emit(event(request('old-dialog')));
      await view.emit(event(request('new-dialog')));
      await close(view, mode, [request('new-dialog')]);
      assert.equal(await view.page.locator('.dialog-title').textContent(), 'new-dialog');
      assert.equal((await focused(view)).text, 'first');
      await view.page.keyboard.press('ArrowDown');
      await view.emit(event({ type: 'pimux_dialog_closed', id: 'old-dialog' }));
      assert.equal((await focused(view)).text, 'second');
      assert.equal(view.requests.filter(item => item.body?.type === 'extension_ui_response').length, 0, 'resolution never manufactures cancellation replies');
    } finally { await view.close(); }
  });
}

test('closing a background tab’s dialog cannot move focus in the selected view', async () => {
  const view = await openUI(browser);
  try {
    await view.emit(event(request('old-dialog')));
    await view.select('b');
    await view.page.locator('#command-btn').focus();
    await close(view, 'closed');
    assert.equal((await focused(view)).id, 'command-btn');
    assert.equal(await view.page.locator('.live-tab.active').getAttribute('data-session-id'), 'b');
  } finally { await view.close(); }
});

test('mobile resolution does not summon the composer keyboard', async () => {
  const view = await openUI(browser);
  try {
    await view.page.setViewportSize({ width: 375, height: 740 });
    await view.emit(event(request('old-dialog')));
    await close(view, 'closed');
    assert.notEqual((await focused(view)).id, 'message-input');
  } finally { await view.close(); }
});

test('native registry reconciliation follows the same focus ownership rule', async () => {
  const view = await openUI(browser, [session('a', { attached: null, shared: false })]);
  try {
    await view.emit({ type: 'interaction_state', sessionId: 'a', interactionRevision: 1, pendingDialogs: [{ ...request('native'), createdAt: Date.now() }] });
    assert.equal((await focused(view)).text, 'first');
    await view.emit({ type: 'interaction_state', sessionId: 'a', interactionRevision: 2, pendingDialogs: [] });
    assert.equal((await focused(view)).id, 'message-input');
  } finally { await view.close(); }
});

for (const method of ['input', 'editor'] as const) {
  test(`a delayed ${method} focus callback cannot steal a newer composer keystroke`, async () => {
    const view = await openUI(browser);
    try {
      await view.page.evaluate(() => {
        const original = window.setTimeout.bind(window);
        const callbacks: Array<() => void> = [];
        window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
          if (delay === 100 && typeof handler === 'function') {
            callbacks.push(() => handler(...args));
            return 200000 + callbacks.length;
          }
          return original(handler, delay, ...args);
        }) as typeof window.setTimeout;
        Object.assign(window, { fixtureRunFocusCallbacks() {
          window.setTimeout = original;
          for (const callback of callbacks.splice(0)) callback();
        } });
      });
      await view.emit(event({ ...request('input-dialog'), method }));
      // Run any deferred focus at the exact point after the human has chosen
      // the composer and before their Enter key, rather than waiting on a clock.
      await view.page.locator('#message-input').fill('keep this instruction queued');
      await view.page.evaluate(() => Reflect.get(window, 'fixtureRunFocusCallbacks')());
      assert.equal((await focused(view)).id, 'message-input');
      await view.page.keyboard.press('Enter');
      await view.page.locator('#queued-messages .queued-msg', { hasText: 'keep this instruction queued' }).waitFor();
      assert.equal(view.requests.filter(item => item.body?.type === 'extension_ui_response').length, 0);
      assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
    } finally { await view.close(); }
  });
}
