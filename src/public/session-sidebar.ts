/**
 * Session Sidebar — lists projects, and the sessions of a project once it is
 * expanded. Projects start collapsed and their sessions are fetched on demand,
 * so opening the page costs one directory listing rather than a parse of every
 * stored transcript.
 */

import { isImeComposition } from './keyboard.js';
import { limitSessions } from './session-limit.js';

export type SidebarSession = {
  filePath: string;
  file: string;
  dir: string;
  id?: string;
  name?: string | null;
  firstMessage?: string | null;
  timestamp?: string;
  mtime?: number;
  live?: boolean;
  owner?: unknown;
  /** Mux id when another frontend shares this session through pimux: opening it attaches. */
  shared?: string | null;
};

export type SidebarProject = {
  path: string;
  dirName: string;
  count: number;
  lastActive: number;
};

type SearchResult = Pick<SidebarSession, 'filePath' | 'file' | 'dir' | 'live' | 'owner' | 'shared'> & {
  project: string;
  sessionName?: string;
  sessionTimestamp?: string;
  firstMessage?: string;
  matches: { snippet?: string }[];
};

export class SessionSidebar {
  container: HTMLElement;
  onSessionSelect: (session: SidebarSession | null) => void;
  onNewSession: (cwd: string) => void;
  onError: (message: string) => void;
  activeSessionFile: string | null;
  projects: SidebarProject[];
  sessionsByDir: Map<string, SidebarSession[]>;
  expanded: Set<string>;
  loading: Set<string>;
  /** Projects whose loaded sessions are shown beyond the newest ten. */
  expandedProjects: Set<string>;
  /** Called after rebuilding rows so the app can restore live indicators. */
  onRendered: (() => void) | null = null;
  searchQuery: string;
  _searchTimer: ReturnType<typeof setTimeout> | null = null;
  _searchResults: SearchResult[] | null = null;
  _searchRequest = 0;
  favourites: string[];
  contextMenu: HTMLElement | null;

  constructor(
    container: HTMLElement,
    onSessionSelect: (session: SidebarSession | null) => void,
    onNewSession: (cwd: string) => void,
    onError: (message: string) => void,
  ) {
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.onNewSession = onNewSession;
    this.onError = onError;
    this.activeSessionFile = null;
    this.projects = [];
    this.sessionsByDir = new Map();
    this.expanded = new Set();
    this.loading = new Set();
    this.expandedProjects = new Set();
    this.searchQuery = '';
    this.favourites = JSON.parse(localStorage.getItem('tau-favourites') || '[]');
    this.contextMenu = null;

    // Close context menu on click anywhere
    document.addEventListener('click', () => this.closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // Close if right-clicking outside a session item
      if (!(e.target as Element | null)?.closest('.session-item')) this.closeContextMenu();
    });
  }

  // ═══════════════════════════════════════
  // Loading
  // ═══════════════════════════════════════

  async loadProjects() {
    try {
      this.container.innerHTML = Array.from({ length: 6 }, () =>
        '<div class="session-skeleton"><div class="session-skeleton-title"></div><div class="session-skeleton-meta"></div></div>'
      ).join('');
      const res = await fetch('/api/sessions');
      const data = await res.json();
      this.projects = data.projects || [];
      this.sessionsByDir.clear();
      this.render();
      if (this.searchQuery) await Promise.all(this.projects.map(project => this.loadSessions(project.dirName)));
      else await this.loadFavouriteProjects();
    } catch (error) {
      console.error('[Sidebar] Failed to load projects:', error);
      this.container.innerHTML = '<div class="session-loading">Failed to load sessions</div>';
    }
  }

  /** Picks up sessions that appeared or changed, in place: no skeleton, and open lists stay open. */
  async refresh() {
    if (this.contextMenu || this.container.querySelector('.session-rename-input')) return;
    try {
      const data = await (await fetch('/api/sessions')).json();
      const lists = await Promise.all(Array.from(this.sessionsByDir.keys(), async (dirName) => {
        const list = await (await fetch(`/api/sessions/${encodeURIComponent(dirName)}`)).json();
        return [dirName, list.sessions || []] as const;
      }));
      this.projects = data.projects || [];
      for (const [dirName, sessions] of lists) this.sessionsByDir.set(dirName, sessions);
      this.render();
    } catch {
      /* Tau went away; the reconnect refreshes again. */
    }
  }

  async loadSessions(dirName: string) {
    if (this.sessionsByDir.has(dirName) || this.loading.has(dirName)) return;
    this.loading.add(dirName);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(dirName)}`);
      const data = await res.json();
      this.sessionsByDir.set(dirName, data.sessions || []);
    } catch (error) {
      console.error(`[Sidebar] Failed to load sessions for ${dirName}:`, error);
    } finally {
      this.loading.delete(dirName);
      this.render();
    }
  }

  /** Favourites are shown up front, so their projects are the one thing loaded eagerly. */
  async loadFavouriteProjects() {
    const dirs = new Set(this.favourites.map(filePath => filePath.split('/').slice(-2)[0]));
    await Promise.all(Array.from(dirs).map(dir => this.loadSessions(dir)));
  }

  favouriteSessions() {
    const found: Array<{ session: SidebarSession; project: SidebarProject }> = [];
    for (const project of this.projects) {
      for (const session of this.sessionsByDir.get(project.dirName) || []) {
        if (this.isFavourite(session.filePath)) found.push({ session, project });
      }
    }
    return found;
  }

  // ═══════════════════════════════════════
  // Favourites
  // ═══════════════════════════════════════

  saveFavourites() {
    localStorage.setItem('tau-favourites', JSON.stringify(this.favourites));
  }

  isFavourite(filePath?: string) {
    if (!filePath) return false;
    return this.favourites.includes(filePath);
  }

  toggleFavourite(filePath?: string) {
    if (!filePath) return;
    const idx = this.favourites.indexOf(filePath);
    if (idx >= 0) {
      this.favourites.splice(idx, 1);
    } else {
      this.favourites.push(filePath);
    }
    this.saveFavourites();
    this.render();
  }

  setSearchQuery(query: string) {
    const wasSearching = !!this.searchQuery;
    this.searchQuery = query.toLowerCase().trim();
    ++this._searchRequest;
    this._searchResults = null;
    this.renderSearchResults();

    this.scheduleMessageSearch();

    // Searching shows every session of every project, so the rows are rebuilt
    // whenever the search starts or ends.
    const searchingChanged = wasSearching !== !!this.searchQuery;

    if (!this.searchQuery) {
      this._searchResults = null;
      if (searchingChanged) this.render();
      else this.applySearch();
      return;
    }

    // Keep ordinary browsing lazy. Explicit search loads all project titles,
    // including sessions beyond the ten-row limit and collapsed projects.
    for (const project of this.projects) void this.loadSessions(project.dirName);
    if (searchingChanged) this.render();
    else this.applySearch();
  }

  scheduleMessageSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = null;
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => {
        this._searchTimer = null;
        void this.fullTextSearch(this.searchQuery);
      }, 300);
    }
  }

  async fullTextSearch(query: string) {
    // Don't search if query changed since debounce
    if (query !== this.searchQuery) return;

    const request = ++this._searchRequest;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (request !== this._searchRequest || query !== this.searchQuery) return;
      if (!res.ok) throw new Error(data.error || 'Could not search session messages');
      this._searchResults = data.results || [];
      this.renderSearchResults();
    } catch (err) {
      if (request === this._searchRequest && query === this.searchQuery) {
        this.onError(err instanceof Error ? err.message : 'Could not search session messages');
      }
    }
  }

  renderSearchResults() {
    // Remove previous search results section
    const existing = this.container.querySelector('.search-results-group');
    if (existing) existing.remove();
    if (!this.searchQuery || !this._searchResults?.length) return;

    const group = document.createElement('div');
    group.className = 'search-results-group';

    const header = document.createElement('div');
    header.className = 'project-header search-results-header';
    header.innerHTML = `<span>🔍</span> <span>Message matches</span> <span class="project-count">${this._searchResults.length}</span>`;
    group.appendChild(header);

    const sessionsDiv = document.createElement('div');
    sessionsDiv.className = 'project-sessions';

    for (const result of this._searchResults) {
      const item = document.createElement('div');
      item.className = 'session-item search-result-item';
      item.dataset.filePath = result.filePath;

      if (result.filePath === this.activeSessionFile) {
        item.classList.add('active');
      }

      // Server-supplied identifiers also work before the lazy title list arrives.
      const sessionForResult = (): SidebarSession => ({
        ...this.sessionsByDir.get(result.dir)?.find(session => session.filePath === result.filePath),
        filePath: result.filePath, file: result.file, dir: result.dir,
        name: result.sessionName, firstMessage: result.firstMessage,
        timestamp: result.sessionTimestamp, live: result.live, owner: result.owner, shared: result.shared,
      });
      const title = result.sessionName || result.firstMessage || 'Untitled';
      const snippet = result.matches[0]?.snippet || '';
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);

      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        </div>
        <div class="search-snippet">${this.highlightMatch(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${matchCount} matches` : ''}</div>
      `;

      item.addEventListener('click', () => this.onSessionSelect(sessionForResult()));
      item.addEventListener('contextmenu', event => {
        const project = this.projects.find(project => project.dirName === result.dir);
        if (project) this.showContextMenu(event, sessionForResult(), project, item);
      });

      sessionsDiv.appendChild(item);
    }

    group.appendChild(sessionsDiv);
    // Insert at top of container
    this.container.insertBefore(group, this.container.firstChild);
    this.onRendered?.();
  }

  highlightMatch(text: string, query: string) {
    if (!query) return this.escapeHtml(text);
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let html = '', cursor = 0;
    for (const match of text.matchAll(re)) {
      html += this.escapeHtml(text.slice(cursor, match.index)) + `<mark>${this.escapeHtml(match[0])}</mark>`;
      cursor = match.index + match[0].length;
    }
    return html + this.escapeHtml(text.slice(cursor));
  }

  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('hidden'));
      this.container.querySelectorAll('.project-group').forEach(el => el.style.display = '');
      const favSection = this.container.querySelector('.favourites-group');
      if (favSection) favSection.style.display = '';
      // Remove full-text results
      const searchGroup = this.container.querySelector('.search-results-group');
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search favourites section
    const favSection = this.container.querySelector('.favourites-group');
    if (favSection) {
      let hasVisible = false;
      favSection.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      favSection.style.display = hasVisible ? '' : 'none';
    }

    this.container.querySelectorAll('.project-group').forEach(group => {
      let hasVisible = false;
      group.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? '' : 'none';
    });
  }

  /** The file paths of every session row the projects currently show. */
  visibleSessionKey() {
    return this.projects
      .map(project => this.visibleSessions(project).visible.map(s => s.filePath).join('|'))
      .join('\n');
  }

  visibleSessions(project: SidebarProject) {
    return limitSessions({
      sessions: this.sessionsByDir.get(project.dirName) || [],
      expanded: this.expandedProjects.has(project.dirName),
      searching: !!this.searchQuery,
      activeFilePath: this.activeSessionFile,
    });
  }

  setActive(filePath?: string | null) {
    const before = this.visibleSessionKey();
    this.activeSessionFile = filePath ?? null;
    // The open session is always listed, so the rows can change with it.
    if (before !== this.visibleSessionKey()) {
      this.render();
      return;
    }
    this.container.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.filePath === filePath);
    });
  }

  clearActive() {
    const before = this.visibleSessionKey();
    this.activeSessionFile = null;
    if (before !== this.visibleSessionKey()) {
      this.render();
      return;
    }
    this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  }

  /** Shows a new name for the open session in every row that lists it. */
  setActiveSessionName(name: string) {
    if (this.activeSessionFile) this.setSessionName(this.activeSessionFile, name);
  }

  setSessionName(filePath: string, name: string) {
    ++this._searchRequest;
    for (const result of this._searchResults || []) {
      if (result.filePath === filePath) result.sessionName = name;
    }
    for (const project of this.projects) {
      for (const session of this.sessionsByDir.get(project.dirName) || []) {
        if (session.filePath === filePath) session.name = name;
      }
    }
    this.container.querySelectorAll('.session-item').forEach(el => {
      if (el.dataset.filePath !== filePath) return;
      const title = el.querySelector('.session-title');
      if (!title) return;
      title.textContent = name;
      title.setAttribute('title', name);
    });
    this.applySearch();
    this.scheduleMessageSearch();
  }

  // ═══════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════

  showContextMenu(e: MouseEvent, session: SidebarSession, project: SidebarProject, itemEl: HTMLElement) {
    e.preventDefault();
    this.closeContextMenu();

    const isFav = this.isFavourite(session.filePath);
    const menu = document.createElement('div');
    menu.className = 'session-context-menu';

    const items = [
      { icon: isFav ? '★' : '☆', label: isFav ? 'Unfavourite' : 'Favourite', action: () => this.toggleFavourite(session.filePath) },
      { icon: '✎', label: 'Rename', action: () => this.startRename(itemEl, session) },
      { icon: '📋', label: 'Export HTML', action: () => this.exportSession(session) },
      { icon: '🗑', label: 'Delete', action: () => this.deleteSession(session, project) },
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${item.label}`;
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    // Position
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    this.contextMenu = menu;
  }

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  startRename(itemEl: HTMLElement, session: SidebarSession) {
    const titleEl = itemEl.querySelector('.session-title');
    if (!titleEl) return;
    const currentName = titleEl.textContent;

    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.value = currentName;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      let name = input.value.trim() || currentName;
      if (name !== currentName) {
        try {
          const data = await (await fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'set_session_name', name, filePath: session.filePath }),
          })).json();
          if (data.success === false) throw new Error(data.error || 'Could not rename the session');
          session.name = name;
          this.setSessionName(session.filePath, name);
        } catch (error) {
          this.onError(error instanceof Error ? error.message : 'Could not rename the session');
          name = currentName;
        }
      }
      const newTitle = document.createElement('div');
      newTitle.className = 'session-title';
      newTitle.title = name;
      newTitle.textContent = name;
      input.replaceWith(newTitle);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ke) => {
      if (isImeComposition(ke)) return;
      if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
      if (ke.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  async deleteSession(session: SidebarSession, project: SidebarProject) {
    if (!confirm(`Delete "${session.name || session.firstMessage || 'this session'}"?`)) return;
    try {
      const res = await fetch('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: session.filePath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        this.onError(data?.error || 'Could not delete the session');
        return;
      }
      ++this._searchRequest;
      this.scheduleMessageSearch();
      this._searchResults = this._searchResults?.filter(result => result.filePath !== session.filePath) ?? null;
      const sessions = this.sessionsByDir.get(project.dirName);
      if (sessions) this.sessionsByDir.set(project.dirName, sessions.filter(s => s.filePath !== session.filePath));
      project.count = Math.max(0, project.count - 1);
      const favIdx = this.favourites.indexOf(session.filePath);
      if (favIdx >= 0) {
        this.favourites.splice(favIdx, 1);
        this.saveFavourites();
      }
      if (session.filePath === this.activeSessionFile) {
        this.clearActive();
        this.onSessionSelect(null);
      }
      this.render();
    } catch (e) {
      console.error('[Sidebar] Delete failed:', e);
      this.onError('Could not delete the session');
    }
  }

  async exportSession(session: SidebarSession) {
    try {
      const data = await (await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'export_html', filePath: session.filePath }),
      })).json();
      if (data?.success && data.data?.path) {
        await fetch('/api/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: data.data.path }),
        });
      }
    } catch { /* silent */ }
  }

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  buildSessionItem(session: SidebarSession, project: SidebarProject) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.filePath = session.filePath;

    if (session.filePath === this.activeSessionFile) {
      item.classList.add('active');
    }

    const title = session.name || session.firstMessage || 'Empty session';
    const time = this.formatTime(session.timestamp);
    const liveTag = session.live ? '<span class="session-tag tmux-tag">live</span>' : '';
    const favIcon = this.isFavourite(session.filePath) ? '<span class="session-fav-icon">★</span>' : '';

    item.innerHTML = `
      <div class="session-title-row">
        ${favIcon}
        <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        ${liveTag}
      </div>
      <div class="session-meta">${time}</div>
    `;

    item.addEventListener('click', () => this.onSessionSelect(session));
    item.addEventListener('contextmenu', (e) => this.showContextMenu(e, session, project, item));

    return item;
  }

  buildProjectGroup(project: SidebarProject) {
    const group = document.createElement('div');
    group.className = 'project-group';
    const isExpanded = this.expanded.has(project.dirName) || !!this.searchQuery;

    const header = document.createElement('div');
    header.className = `project-header${isExpanded ? '' : ' collapsed'}`;

    const shortPath = project.path.split('/').filter(Boolean).pop() || project.path || project.dirName;
    header.innerHTML = `
      <span class="chevron">▼</span>
      <span title="${this.escapeHtml(project.path)}">${this.escapeHtml(shortPath)}</span>
      <span class="project-count">${project.count}</span>
    `;
    header.addEventListener('click', () => this.toggleProject(project));

    const addBtn = document.createElement('button');
    addBtn.className = 'project-add-btn';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addBtn.title = `New session in ${project.path || shortPath}`;
    addBtn.setAttribute('aria-label', 'New session in this project');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onNewSession(project.path);
    });
    header.appendChild(addBtn);
    group.appendChild(header);

    if (isExpanded) {
      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'project-sessions';
      const sessions = this.sessionsByDir.get(project.dirName);
      if (!sessions) {
        sessionsDiv.innerHTML = '<div class="session-loading">Loading sessions…</div>';
      } else {
        this.fillProjectSessions(sessionsDiv, project);
      }
      group.appendChild(sessionsDiv);
    }

    return group;
  }

  toggleProject(project: SidebarProject) {
    if (this.expanded.has(project.dirName)) {
      this.expanded.delete(project.dirName);
      this.render();
      return;
    }
    this.expanded.add(project.dirName);
    this.render();
    this.loadSessions(project.dirName);
  }

  render() {
    if (this.projects.length === 0) {
      this.container.innerHTML = '<div class="session-loading">No sessions found</div>';
      return;
    }

    this.container.innerHTML = '';

    const favSessions = this.favouriteSessions();
    if (favSessions.length > 0) {
      const favGroup = document.createElement('div');
      favGroup.className = 'favourites-group';

      const header = document.createElement('div');
      header.className = 'project-header favourites-header';
      header.innerHTML = `<span class="fav-star">★</span> <span>Favourites</span> <span class="project-count">${favSessions.length}</span>`;
      favGroup.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'project-sessions';
      for (const { session, project } of favSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }
      favGroup.appendChild(sessionsDiv);
      this.container.appendChild(favGroup);
    }

    for (const project of this.projects) {
      this.container.appendChild(this.buildProjectGroup(project));
    }
    if (this.searchQuery) {
      this.applySearch();
      this.renderSearchResults();
    }
    this.onRendered?.();
  }

  /** Show the loaded cache through the upstream limit/active-row policy. */
  fillProjectSessions(sessionsDiv: HTMLElement, project: SidebarProject) {
    sessionsDiv.innerHTML = '';
    const { visible, limited } = this.visibleSessions(project);
    for (const session of visible) sessionsDiv.appendChild(this.buildSessionItem(session, project));
    if (!limited || this.searchQuery) return;

    const expanded = this.expandedProjects.has(project.dirName);
    const total = (this.sessionsByDir.get(project.dirName) || []).length;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `project-more-btn${expanded ? ' expanded' : ''}`;
    toggle.innerHTML = `<span class="chevron">▼</span><span>${expanded ? 'Show fewer' : `Show all ${total}`}</span>`;
    toggle.addEventListener('click', () => {
      if (expanded) this.expandedProjects.delete(project.dirName);
      else this.expandedProjects.add(project.dirName);
      this.fillProjectSessions(sessionsDiv, project);
      this.onRendered?.();
    });
    sessionsDiv.appendChild(toggle);
  }

  formatTime(isoTimestamp?: string) {
    try {
      const date = new Date(isoTimestamp || '');
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const days = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (days === 1) return 'Yesterday';
      if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  /** Also used inside quoted attributes, so quotes are escaped too. */
  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML.replace(/"/g, '&quot;');
  }
}
