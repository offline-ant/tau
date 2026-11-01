import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { searchSessions } from '../../src/server/session-search.ts';
import type * as SidebarModule from '../../src/public/session-sidebar.js';

// The real compiled UI, with every request intercepted. No server, sockets,
// discovery, settings, Pi processes or providers run in this suite.
const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
let browser: Browser;
before(async () => {
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
});
after(async () => { await browser?.close(); });

async function open(options: { holdTitles?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-search-browser-'));
  const dir = 'synthetic-project';
  fs.mkdirSync(path.join(root, dir));
  const sessions = Array.from({ length: 12 }, (_, i) => {
    const file = `${String(i).padStart(2, '0')}.jsonl`, filePath = path.join(root, dir, file);
    const session = { dir, file, filePath, name: `Title${i}`, timestamp: '2026-01-01T00:00:00Z', mtime: 12 - i,
      owner: i === 0 ? { name: 'synthetic-owner', host: 'emacs' } : null, shared: i === 1 ? 'synthetic-mux' : null };
    fs.writeFileSync(filePath, [
      { type: 'session', id: `session-${i}`, cwd: '/synthetic/project' },
      { type: 'message', message: { role: 'user', content: 'A literal need.le <&> in the message' } },
      { type: 'session_info', name: session.name },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    return session;
  });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } });
  const page = await context.newPage(), errors: string[] = [], requests: string[] = [], resumes: unknown[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseTitles: () => void = () => {};
  const titles = options.holdTitles ? new Promise<void>(resolve => { releaseTitles = resolve; }) : Promise.resolve();
  let activeFile = sessions[0].filePath;
  const live = () => ({ id: 'resumed', cwd: '/synthetic/project', sessionFile: activeFile, sessionName: 'Resumed', model: null,
    isStreaming: false, ...(sessions.find(session => session.filePath === activeFile)?.shared ? { attached: { muxId: 'synthetic-mux', host: 'emacs' } } : {}) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.host, 'tau.invalid', 'Every request must stay in the routed fixture');
    requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/sessions') return route.fulfill({ json: { projects: [{ path: '/synthetic/project', dirName: dir, count: sessions.length, lastActive: 12 }] } });
    if (url.pathname === '/api/sessions/' + dir) { await titles; return route.fulfill({ json: { sessions } }); }
    if (url.pathname.startsWith('/api/sessions/' + dir + '/')) return route.fulfill({ json: { entries: [], offset: 0 } });
    if (url.pathname === '/api/search') {
      const results = (await searchSessions(root, url.searchParams.get('q') || '')).map(result => ({ ...result,
        owner: sessions.find(session => session.filePath === result.filePath)?.owner,
        shared: sessions.find(session => session.filePath === result.filePath)?.shared,
      }));
      return route.fulfill({ json: { results } });
    }
    if (url.pathname === '/api/live-sessions/resume') {
      const body = request.postDataJSON(); resumes.push(body); activeFile = body.filePath;
      return route.fulfill({ json: { session: live() } });
    }
    if (url.pathname === '/api/live-sessions/resumed/snapshot') return route.fulfill({ json: { session: live(), entries: [], isStreaming: false } });
    if (url.pathname === '/api/rpc') return route.fulfill({ json: { success: true, data: request.postDataJSON().type === 'get_available_models' ? { models: [] } : {} } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { sessions: [], projects: [], platform: 'linux' } });
    const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
  await context.addInitScript(() => {
    const sent: unknown[] = [];
    Object.assign(window, { sentCommands: sent });
    class Socket {
      static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event('open'));
          this.onmessage?.({ data: JSON.stringify({ type: 'state', liveSessions: [], agents: [] }) });
        }, 0);
      }
      send(data: string) { sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket });
  });
  try {
    await page.goto('http://tau.invalid/');
    await page.locator('.project-group').waitFor();
    return { page, requests, resumes, sessions, errors, releaseTitles, async close() {
      releaseTitles(); await context.close(); fs.rmSync(root, { recursive: true, force: true });
    } };
  } catch (error) { releaseTitles(); await context.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
async function idleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('search wiring leaves startup lazy and finds older titles without changing show-all or active rows', async () => {
  const view = await open();
  try {
    const { page } = view;
    assert.equal(view.requests.some(request => request.includes('/api/sessions/synthetic-project') || request.includes('/api/search')), false);
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill('Title11');
    await page.locator('.project-group .session-item:not(.hidden)', { hasText: 'Title11' }).waitFor();
    assert.equal(await page.locator('.project-group .session-item:not(.hidden)').count(), 1);
    await page.getByRole('searchbox').fill('');
    assert.equal(await page.locator('.project-group .session-item').count(), 0, 'clearing restores collapsed projects');
    await page.locator('.project-group .project-header').click();
    assert.equal(await page.locator('.project-group .session-item').count(), 10);
    await page.getByRole('button', { name: 'Show all 12' }).click();
    assert.equal(await page.locator('.project-group .session-item').count(), 12);
    await page.locator('.project-group .session-item', { hasText: 'Title11' }).click();
    await page.locator('.live-tab.active').waitFor();
    await page.getByRole('button', { name: 'Show fewer' }).click();
    assert.equal(await page.locator('.project-group .session-item').count(), 11, 'older active row stays visible');
    await page.getByRole('searchbox').fill('Title11');
    await page.getByRole('searchbox').fill('');
    assert.equal(await page.locator('.project-group .session-item').count(), 11);
    assert.deepEqual(view.resumes, [{ filePath: view.sessions[11].filePath }]);
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('fulltext results before lazy titles retain ownership and use normal guarded session selection', async () => {
  const view = await open({ holdTitles: true });
  try {
    const { page } = view;
    await page.getByRole('searchbox').fill('need.le <&>');
    await page.locator('.search-result-item').first().waitFor();
    assert.equal(await page.locator('.search-result-item').count(), 12);
    assert.equal(await page.locator('.search-result-item mark').first().textContent(), 'need.le <&>');
    assert.equal(await page.locator('.search-result-item img').count(), 0);
    await page.locator('.search-result-item', { hasText: 'Title0' }).click();
    await page.locator('.system-message', { hasText: 'Read-only: synthetic-owner' }).waitFor();
    assert.deepEqual(view.resumes, [], 'owned result must follow without attempting a writer');
    await page.locator('.search-result-item', { hasText: 'Title1' }).filter({ has: page.locator('.session-title', { hasText: /^Title1$/ }) }).click();
    await page.locator('.live-tab.shared').waitFor();
    assert.deepEqual(view.resumes, [{ filePath: view.sessions[1].filePath }], 'shared result must use the normal server resolution, with no force/args');
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'sentCommands')), []);
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('stale searches, names, deletion and highlighting preserve current result data', async () => {
  const view = await open();
  try {
    const result = await view.page.evaluate(async () => {
      const moduleUrl = '/session-sidebar.js';
      const { SessionSidebar } = await import(moduleUrl) as typeof SidebarModule;
      const container = document.createElement('div'); document.body.appendChild(container);
      const selected: unknown[] = [];
      const sidebar = new SessionSidebar(container, session => selected.push(session), () => {}, message => { throw new Error(message); });
      const project = { path: '/synthetic', dirName: 'project', count: 1, lastActive: 0 };
      const session = { filePath: '/synthetic/project/file.jsonl', dir: 'project', file: 'file.jsonl', name: 'Original', owner: null };
      sidebar.projects = [project]; sidebar.sessionsByDir.set('project', [session]);
      const originalFetch = window.fetch, originalConfirm = window.confirm;
      const pending: Array<(response: Response) => void> = [];
      window.fetch = async input => String(input).startsWith('/api/search')
        ? new Promise<Response>(resolve => pending.push(resolve)) : Response.json({ success: true });
      window.confirm = () => true;
      try {
        const answer = (name: string) => Response.json({ results: [{ ...session, owner: { name: 'owner', host: 'emacs' }, project: '/synthetic', sessionName: name, matches: [{ snippet: 'alpha & <img src=x onerror=alert(1)>' }] }] });
        sidebar.setSearchQuery('alpha'); const oldA = sidebar.fullTextSearch('alpha');
        sidebar.setSearchQuery('beta'); const oldB = sidebar.fullTextSearch('beta');
        sidebar.setSearchQuery('alpha'); const newA = sidebar.fullTextSearch('alpha');
        pending[2](answer('Latest')); await newA;
        pending[1](answer('Wrong beta')); pending[0](answer('Wrong alpha')); await Promise.all([oldA, oldB]);
        const latest = container.querySelector('.search-result-item .session-title')?.textContent;
        (container.querySelector('.search-result-item') as HTMLElement).click();
        const selectedOwner = (selected[0] as { owner: unknown }).owner;
        sidebar.setActive(session.filePath); sidebar.setActiveSessionName('Updated <&>'); sidebar.render();
        const name = container.querySelector('.search-result-item .session-title')?.textContent;
        const snippet = document.createElement('div'); snippet.innerHTML = sidebar.highlightMatch('amp & <img src=x>', 'amp');
        const highlighting = { text: snippet.textContent, marks: Array.from(snippet.querySelectorAll('mark'), mark => mark.textContent), images: snippet.querySelectorAll('img').length };
        await sidebar.deleteSession(session, project); sidebar.render();
        const afterDelete = { matches: sidebar._searchResults?.length, rows: container.querySelectorAll('.search-result-item').length, sessions: sidebar.sessionsByDir.get('project')?.length };
        sidebar.setSearchQuery('x');
        const afterShortQuery = container.querySelectorAll('.search-results-group').length;
        sidebar.setSearchQuery('');
        return { latest, selectedOwner, name, highlighting, afterDelete, afterShortQuery };
      } finally { window.fetch = originalFetch; window.confirm = originalConfirm; container.remove(); }
    });
    assert.deepEqual(result, { latest: 'Latest', selectedOwner: { name: 'owner', host: 'emacs' }, name: 'Updated <&>', highlighting: { text: 'amp & <img src=x>', marks: ['amp'], images: 0 },
      afterDelete: { matches: 0, rows: 0, sessions: 0 }, afterShortQuery: 0 });
    await idleFrames(view.page);
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});
