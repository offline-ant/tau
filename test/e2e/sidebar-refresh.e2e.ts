import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type * as SidebarModule from '../../src/public/session-sidebar.js';

type Outcome = 'success' | 'network' | 'http' | 'json';
type Request = { url: string; reply: (data: unknown, status?: number) => void; fail: () => void; badJson: () => void };
type Harness = {
  sidebar: SidebarModule.SessionSidebar;
  next: (url: string) => Promise<Request>;
  urls: string[];
  loads: Promise<void>[];
  selected: Array<SidebarModule.SidebarSession | null>;
  project: (dir: string) => SidebarModule.SidebarProject;
  sessions: (dir: string, name?: string, count?: number) => SidebarModule.SidebarSession[];
  settle: (request: Request, outcome: Outcome) => void;
  renders: number;
};
declare global { interface Window { sidebarTest: Harness } }

let browser: Browser;
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
before(async () => {
  const executablePath = process.env.CHROMIUM_BINARY || [chromium.executablePath(), '/usr/bin/chromium'].find(file => fs.existsSync(file));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

async function fixture(t: TestContext) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  t.signal.addEventListener('abort', () => void context.close(), { once: true });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, 'http://tau.invalid');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="sidebar"></div>' });
    assert.ok(['/session-sidebar.js', '/keyboard.js', '/session-limit.js'].includes(url.pathname), `Unexpected request: ${url}`);
    return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(publicDir, url.pathname.slice(1))) });
  });
  const page = await context.newPage();
  await page.goto('http://tau.invalid');
  await page.evaluate(async () => {
    const moduleUrl = '/session-sidebar.js';
    const { SessionSidebar } = await import(moduleUrl) as typeof SidebarModule;
    const queue: Request[] = [], waiters: Array<(request: Request) => void> = [];
    const urls: string[] = [], loads: Promise<void>[] = [], selected: Array<SidebarModule.SidebarSession | null> = [];
    const response = (data: unknown, status = 200) => ({ ok: status < 400, json: async () => data }) as Response;
    window.fetch = input => new Promise<Response>((resolve, reject) => {
      const url = String(input);
      urls.push(url);
      const request: Request = {
        url, reply: (data, status) => resolve(response(data, status)),
        fail: () => reject(new Error('Synthetic network failure')),
        badJson: () => resolve({ ok: true, json: async () => { throw new Error('Synthetic invalid JSON'); } } as Response),
      };
      const waiter = waiters.shift();
      if (waiter) waiter(request); else queue.push(request);
    });
    localStorage.setItem('tau-favourites', '[]');
    window.confirm = () => true;
    const sidebar = new SessionSidebar(document.getElementById('sidebar')!, session => selected.push(session), () => {}, message => { throw new Error(message); });
    const load = sidebar.loadSessions.bind(sidebar);
    sidebar.loadSessions = (...args) => { const pending = load(...args); loads.push(pending); return pending; };
    let renders = 0;
    sidebar.onRendered = () => { ++renders; };
    window.sidebarTest = {
      sidebar, urls, loads, selected, get renders() { return renders; },
      next: async url => {
        const request = queue.shift() || await new Promise<Request>(resolve => waiters.push(resolve));
        if (request.url !== url) throw new Error(`Expected ${url}, received ${request.url}`);
        return request;
      },
      project: dir => ({ path: `/projects/${dir}`, dirName: dir, count: 12, lastActive: 0 }),
      sessions: (dir, name = dir, count = 1) => Array.from({ length: count }, (_, index) => ({
        dir, file: `${index}.jsonl`, filePath: `/sessions/${dir}/${index}.jsonl`, name: `${name}-${index}`, mtime: count - index,
      })),
      settle: (request, outcome) => {
        if (outcome === 'network') request.fail();
        else if (outcome === 'json') request.badJson();
        else request.reply(outcome === 'success' ? { projects: [{ path: '/stale', dirName: 'stale', count: 1, lastActive: 0 }], sessions: [{ filePath: '/stale', name: 'Stale' }] } : {}, outcome === 'success' ? 200 : 503);
      },
    };
  });
  return page;
}

test('startup stays lazy; reload fetches the current expanded/favourite union and retains row policies', { timeout: 15000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const h = window.sidebarTest, s = h.sidebar;
    let pending = s.loadProjects();
    (await h.next('/api/sessions')).reply({ projects: ['a', 'b', 'c'].map(h.project) });
    await pending;
    const startup = [...h.urls];
    s.expanded.add('a'); s.expanded.add('removed');
    s.expandedProjects.add('a'); s.expandedProjects.add('removed');
    s.favourites = ['/sessions/b/0.jsonl', '/sessions/removed/0.jsonl'];
    s.setActive('/sessions/a/11.jsonl');
    pending = s.loadProjects();
    (await h.next('/api/sessions')).reply({ projects: ['a', 'b', 'c'].map(h.project) });
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Reloaded', 12) });
    (await h.next('/api/sessions/b')).reply({ sessions: h.sessions('b') });
    await pending;
    const union = { cache: [...s.sessionsByDir.keys()], expanded: [...s.expanded], all: [...s.expandedProjects], rows: s.visibleSessions(s.projects[0]).visible.length, favourites: s.container.querySelectorAll('.favourites-group .session-item').length };
    pending = s.loadProjects();
    (await h.next('/api/sessions')).reply({ projects: ['a', 'c'].map(h.project) });
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Again', 12) });
    await pending;
    await s.loadFavouriteProjects(); // The stale favourite must not fetch a removed project.
    s.expandedProjects.delete('a'); s.render();
    const limited = s.visibleSessions(s.projects[0]).visible.map(session => session.file);
    (s.container.querySelector('.project-more-btn') as HTMLButtonElement).click();
    return { startup, union, cache: [...s.sessionsByDir.keys()], urls: h.urls, limited, allRows: s.container.querySelectorAll('.project-group .session-item').length, active: s.container.querySelector('.session-item.active')?.getAttribute('data-file-path') };
  });
  assert.deepEqual(result.startup, ['/api/sessions']);
  assert.deepEqual(result.union, { cache: ['a', 'b'], expanded: ['a'], all: ['a'], rows: 12, favourites: 1 });
  assert.deepEqual(result.cache, ['a']);
  assert.deepEqual(result.urls, ['/api/sessions', '/api/sessions', '/api/sessions/a', '/api/sessions/b', '/api/sessions', '/api/sessions/a']);
  assert.deepEqual(result.limited, [...Array.from({ length: 10 }, (_, i) => `${i}.jsonl`), '11.jsonl']);
  assert.equal(result.allRows, 12);
  assert.equal(result.active, '/sessions/a/11.jsonl');
});

for (const outcome of ['success', 'network', 'http', 'json'] as const) {
  test(`superseded summary ${outcome} cannot replace newer projects or their loading state`, { timeout: 15000 }, async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async outcome => {
      const h = window.sidebarTest, s = h.sidebar;
      s.expanded.add('a');
      const old = s.refresh(), oldRequest = await h.next('/api/sessions');
      const current = s.loadProjects();
      (await h.next('/api/sessions')).reply({ projects: [h.project('a'), h.project('b')] });
      const list = await h.next('/api/sessions/a');
      const before = h.renders;
      h.settle(oldRequest, outcome); await old;
      const interim = { projects: s.projects.map(project => project.dirName), loading: [...s.loading], unchanged: before === h.renders, retries: s.container.querySelectorAll('.session-retry-btn').length };
      list.reply({ sessions: h.sessions('a', 'Current') }); await current;
      // A stale summary must not erase a newer failure either.
      const stale = s.loadProjects(), staleRequest = await h.next('/api/sessions');
      const failed = s.refresh(); (await h.next('/api/sessions')).fail(); await failed;
      const errorBefore = s.container.textContent;
      h.settle(staleRequest, outcome); await stale;
      return { interim, cache: s.sessionsByDir.get('a')?.[0].name, errorRetained: errorBefore === s.container.textContent, retry: s.container.querySelector('.session-retry-btn')?.textContent };
    }, outcome);
    assert.deepEqual(result.interim, { projects: ['a', 'b'], loading: ['a'], unchanged: true, retries: 0 });
    assert.equal(result.cache, 'Current-0');
    assert.equal(result.errorRetained, true);
    assert.equal(result.retry, 'Retry');
  });

  test(`superseded project ${outcome} cannot change current success, error or finally/loading state`, { timeout: 15000 }, async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async outcome => {
      const h = window.sidebarTest, s = h.sidebar;
      const initial = s.loadProjects(); (await h.next('/api/sessions')).reply({ projects: [h.project('a')] }); await initial;
      s.expanded.add('a');
      const snapshots: unknown[] = [];
      for (const phase of ['pending', 'success', 'error']) {
        const old = s.loadSessions('a', true), oldRequest = await h.next('/api/sessions/a');
        const current = s.loadSessions('a', true), request = await h.next('/api/sessions/a');
        if (phase !== 'pending') {
          if (phase === 'error') request.fail(); else request.reply({ sessions: h.sessions('a', 'Current') });
          await current;
        }
        const before = h.renders, html = s.container.innerHTML, cache = s.sessionsByDir.get('a');
        h.settle(oldRequest, outcome); await old;
        snapshots.push({ unchanged: before === h.renders && html === s.container.innerHTML && cache === s.sessionsByDir.get('a'), loading: s.loading.has('a'), retry: !!s.container.querySelector('.session-retry-btn') });
        if (phase === 'pending') { request.reply({ sessions: h.sessions('a', 'Current') }); await current; }
      }
      return { snapshots, name: s.sessionsByDir.get('a')?.[0].name };
    }, outcome);
    assert.deepEqual(result.snapshots, [
      { unchanged: true, loading: true, retry: false },
      { unchanged: true, loading: false, retry: false },
      { unchanged: true, loading: false, retry: true },
    ]);
    assert.equal(result.name, 'Current-0');
  });
}

test('summary refresh supersedes old lists, prunes removed projects and ignores stale controls', { timeout: 15000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const h = window.sidebarTest, s = h.sidebar;
    s.expanded.add('a'); s.expandedProjects.add('a');
    s.favourites = ['/sessions/b/0.jsonl'];
    const initial = s.loadProjects(); (await h.next('/api/sessions')).reply({ projects: ['a', 'b', 'c'].map(h.project) });
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Original', 12) });
    (await h.next('/api/sessions/b')).reply({ sessions: h.sessions('b') }); await initial;
    const removed = s.projects[0], staleMore = s.container.querySelector('.project-more-btn') as HTMLButtonElement;
    const old = s.loadSessions('a', true), oldRequest = await h.next('/api/sessions/a');
    const refresh = s.refresh();
    (await h.next('/api/sessions')).reply({ projects: [h.project('b'), h.project('c')] });
    const current = await h.next('/api/sessions/b');
    const before = h.renders;
    oldRequest.fail(); await old;
    const loading = [...s.loading], unchanged = before === h.renders;
    s.toggleProject(removed); staleMore.click(); await s.loadSessions('a', true);
    current.reply({ sessions: h.sessions('b', 'Fresh') }); await refresh;
    return { projects: s.projects.map(project => project.dirName), cache: [...s.sessionsByDir.keys()], expanded: [...s.expanded], all: [...s.expandedProjects], loading, unchanged, urls: h.urls, name: s.sessionsByDir.get('b')?.[0].name };
  });
  assert.deepEqual(result.projects, ['b', 'c']);
  assert.deepEqual(result.cache, ['b']);
  assert.deepEqual(result.expanded, []); assert.deepEqual(result.all, []);
  assert.deepEqual(result.loading, ['b']); assert.equal(result.unchanged, true);
  assert.deepEqual(result.urls, ['/api/sessions', '/api/sessions/a', '/api/sessions/b', '/api/sessions/a', '/api/sessions', '/api/sessions/b']);
  assert.equal(result.name, 'Fresh-0');
});

test('collapse/reopen isolates pending requests while collapsed favourites still finish loading', { timeout: 15000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const h = window.sidebarTest, s = h.sidebar;
    const initial = s.loadProjects(); (await h.next('/api/sessions')).reply({ projects: ['a', 'b'].map(h.project) }); await initial;
    s.toggleProject(s.projects[0]); const old = h.loads.at(-1)!; const oldRequest = await h.next('/api/sessions/a');
    s.toggleProject(s.projects[0]); const collapsed = { expanded: [...s.expanded], loading: [...s.loading], lists: s.container.querySelectorAll('.project-sessions').length };
    s.toggleProject(s.projects[0]); const current = h.loads.at(-1)!; const request = await h.next('/api/sessions/a');
    const before = h.renders; oldRequest.reply({ sessions: h.sessions('a', 'Stale') }); await old;
    const unchanged = before === h.renders && s.loading.has('a') && !s.sessionsByDir.has('a');
    request.reply({ sessions: h.sessions('a', 'Current') }); await current;
    s.favourites = ['/sessions/b/0.jsonl'];
    s.toggleProject(s.projects[1]); const favourite = h.loads.at(-1)!; const favouriteRequest = await h.next('/api/sessions/b');
    s.toggleProject(s.projects[1]); const favouritePending = s.loading.has('b');
    favouriteRequest.reply({ sessions: h.sessions('b') }); await favourite;
    return { collapsed, unchanged, favouritePending, expanded: [...s.expanded], favourites: s.favouriteSessions().map(item => item.session.filePath), name: s.sessionsByDir.get('a')?.[0].name };
  });
  assert.deepEqual(result.collapsed, { expanded: [], loading: [], lists: 0 });
  assert.equal(result.unchanged, true); assert.equal(result.favouritePending, true);
  assert.deepEqual(result.expanded, ['a']); assert.deepEqual(result.favourites, ['/sessions/b/0.jsonl']);
  assert.equal(result.name, 'Current-0');
});

test('HTTP, parsing and network errors have explicit retries and retain usable cached rows', { timeout: 15000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const h = window.sidebarTest, s = h.sidebar;
    const retry = () => (s.container.querySelector('.session-retry-btn') as HTMLButtonElement).click();
    const initial = s.loadProjects(); (await h.next('/api/sessions')).reply({}, 503); await initial;
    const globalRetry = s.container.textContent?.includes('Could not load projects.');
    retry(); (await h.next('/api/sessions')).reply({ projects: [h.project('a')] });
    // Calling loadProjects again would hide bugs in the actual retry control. Wait for its render instead.
    await new Promise<void>(resolve => { const previous = s.onRendered; s.onRendered = () => { previous?.(); s.onRendered = previous; resolve(); }; });
    s.toggleProject(s.projects[0]); let pending = h.loads.at(-1)!;
    (await h.next('/api/sessions/a')).reply({}, 403); await pending;
    const failures: boolean[] = [];
    for (const outcome of ['json', 'network', 'http'] as const) {
      failures.push(!s.loading.has('a') && !!s.container.querySelector('.session-retry-btn'));
      retry(); pending = h.loads.at(-1)!; h.settle(await h.next('/api/sessions/a'), outcome); await pending;
    }
    retry(); pending = h.loads.at(-1)!;
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Recovered', 12) }); await pending;
    const refresh = s.refresh(); (await h.next('/api/sessions')).reply({ projects: [h.project('a')] });
    (await h.next('/api/sessions/a')).reply({ wrong: 'shape' }); await refresh;
    const preserved = s.container.querySelector('.session-title')?.textContent;
    const toggles = [];
    for (let i = 0; i < 2; ++i) {
      (s.container.querySelector('.project-more-btn') as HTMLButtonElement).click();
      toggles.push({ rows: s.container.querySelectorAll('.session-item').length, retry: !!s.container.querySelector('.session-retry-btn') });
    }
    retry(); pending = h.loads.at(-1)!;
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Fresh') }); await pending;
    return { globalRetry, failures, preserved, toggles, name: s.container.querySelector('.session-title')?.textContent, loading: [...s.loading], retries: s.container.querySelectorAll('.session-retry-btn').length };
  });
  assert.equal(result.globalRetry, true); assert.deepEqual(result.failures, [true, true, true]);
  assert.equal(result.preserved, 'Recovered-0'); assert.equal(result.name, 'Fresh-0');
  assert.deepEqual(result.toggles, [{ rows: 12, retry: true }, { rows: 10, retry: true }]);
  assert.deepEqual(result.loading, []); assert.equal(result.retries, 0);
});

test('search during summaries loads every current project and keeps title-load retries visible', { timeout: 15000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const h = window.sidebarTest, s = h.sidebar;
    const initial = s.loadProjects();
    s.setSearchQuery('k'); // One character: title search only, no debounce timer or fulltext request.
    (await h.next('/api/sessions')).reply({ projects: ['a', 'b'].map(h.project) });
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Kind') });
    (await h.next('/api/sessions/b')).fail(); await initial;
    const failedGroup = s.container.querySelectorAll<HTMLElement>('.project-group')[1];
    const retryVisible = failedGroup.style.display !== 'none' && !!failedGroup.querySelector('.session-retry-btn');
    (failedGroup.querySelector('.session-retry-btn') as HTMLButtonElement).click(); const pending = h.loads.at(-1)!;
    (await h.next('/api/sessions/b')).reply({ sessions: h.sessions('b', 'Kind too') }); await pending;
    const matching = s.container.querySelectorAll('.session-item:not(.hidden)').length;
    s.setSearchQuery('');
    return { retryVisible, matching, expanded: [...s.expanded], openLists: s.container.querySelectorAll('.project-sessions').length, urls: h.urls };
  });
  assert.equal(result.retryVisible, true); assert.equal(result.matching, 2);
  assert.deepEqual(result.expanded, []); assert.equal(result.openLists, 0);
  assert.deepEqual(result.urls, ['/api/sessions', '/api/sessions/a', '/api/sessions/b', '/api/sessions/b']);
});

test('older pending lists cannot undo session names or successful deletion', { timeout: 15000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const h = window.sidebarTest, s = h.sidebar;
    s.expanded.add('a'); s.favourites = ['/sessions/a/0.jsonl'];
    const initial = s.loadProjects(); (await h.next('/api/sessions')).reply({ projects: [h.project('a')] });
    (await h.next('/api/sessions/a')).reply({ sessions: h.sessions('a', 'Original', 12) }); await initial;
    s.setActive('/sessions/a/0.jsonl');
    const oldName = s.loadSessions('a', true), nameRequest = await h.next('/api/sessions/a');
    s.setActiveSessionName('Renamed'); nameRequest.reply({ sessions: h.sessions('a', 'Stale', 12) }); await oldName;
    const name = s.sessionsByDir.get('a')?.[0].name;
    const oldDelete = s.loadSessions('a', true), deleteRequest = await h.next('/api/sessions/a');
    const deletion = s.deleteSession(s.sessionsByDir.get('a')![0], s.projects[0]);
    (await h.next('/api/sessions/delete')).reply({}); await deletion;
    deleteRequest.reply({ sessions: h.sessions('a', 'Stale', 12) }); await oldDelete;
    return { name, rows: s.sessionsByDir.get('a')?.length, deleted: !s.sessionsByDir.get('a')?.some(session => session.filePath === '/sessions/a/0.jsonl'), active: s.activeSessionFile, favourites: s.favourites, selected: h.selected, loading: [...s.loading] };
  });
  assert.equal(result.name, 'Renamed'); assert.equal(result.rows, 11); assert.equal(result.deleted, true);
  assert.equal(result.active, null); assert.deepEqual(result.favourites, []); assert.deepEqual(result.selected, [null]); assert.deepEqual(result.loading, []);
});
