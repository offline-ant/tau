/**
 * Session Sidebar — lists projects, and the sessions of a project once it is
 * expanded. Projects start collapsed and their sessions are fetched on demand,
 * so opening the page costs one directory listing rather than a parse of every
 * stored transcript.
 */

import { isImeComposition } from './keyboard.js';

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
};

export type SidebarProject = {
  path: string;
  dirName: string;
  count: number;
  lastActive: number;
};

export class SessionSidebar {
  container: HTMLElement;
  onSessionSelect: (session: SidebarSession | null) => void;
  onNewSession: (cwd: string) => void;
  activeSessionFile: string | null;
  projects: SidebarProject[];
  sessionsByDir: Map<string, SidebarSession[]>;
  expanded: Set<string>;
  loading: Set<string>;
  favourites: string[];
  contextMenu: HTMLElement | null;

  constructor(
    container: HTMLElement,
    onSessionSelect: (session: SidebarSession | null) => void,
    onNewSession: (cwd: string) => void,
  ) {
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.onNewSession = onNewSession;
    this.activeSessionFile = null;
    this.projects = [];
    this.sessionsByDir = new Map();
    this.expanded = new Set();
    this.loading = new Set();
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
      await this.loadFavouriteProjects();
    } catch (error) {
      console.error('[Sidebar] Failed to load projects:', error);
      this.container.innerHTML = '<div class="session-loading">Failed to load sessions</div>';
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

  setActive(filePath?: string | null) {
    this.activeSessionFile = filePath ?? null;
    this.container.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.filePath === filePath);
    });
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
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
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'set_session_name', name: newName, filePath: session.filePath }),
          });
          session.name = newName;
        } catch { /* silent */ }
      }
      const newTitle = document.createElement('div');
      newTitle.className = 'session-title';
      newTitle.title = newName || currentName;
      newTitle.textContent = newName || currentName;
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
      if (!res.ok) return;
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
    const isExpanded = this.expanded.has(project.dirName);

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
        for (const session of sessions) sessionsDiv.appendChild(this.buildSessionItem(session, project));
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

  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }
}
