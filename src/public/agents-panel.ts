/**
 * Agent overview: every Pi shared through pimux (Emacs agents and their
 * workers), grouped by directory, workers nested under their parent, the most
 * urgent first. Tapping one attaches a Tau tab to it.
 */

import { moveListFocus } from './keyboard.js';

export type AgentStatus = 'starting' | 'blocked' | 'working' | 'done' | 'idle';
export type OverviewAgent = {
  muxId: string;
  name: string;
  cwd: string;
  status: AgentStatus;
  detail: string | null;
  placement: string;
  host: string | null;
  sessionFile: string | null;
  model: string | null;
  parentId: string | null;
  tabId: string | null;
};

const ORDER: Record<AgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, starting: 4 };
const ICON: Record<AgentStatus, string> = { blocked: '◉', working: '◐', done: '●', idle: '○', starting: '·' };

type Node = { agent: OverviewAgent; children: Node[]; rank: number };

/** Discovery files hold arbitrary text, so everything here is built as nodes, never as markup. */
function element(tag: string, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function basename(dir: string) {
  return dir.split('/').filter(Boolean).pop() || dir || '/';
}

/** Groups by directory; within a group workers sit under their parent, and every level is sorted by urgency. */
export function buildAgentGroups(agents: OverviewAgent[]): Array<{ cwd: string; nodes: Node[]; rank: number }> {
  const nodes = new Map(agents.map((agent) => [agent.muxId, { agent, children: [] as Node[], rank: ORDER[agent.status] ?? 9 }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.agent.parentId ? nodes.get(node.agent.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // A parent is as urgent as its most urgent worker.
  const rank = (node: Node): number => Math.min(node.rank, ...node.children.map(rank));
  const sort = (list: Node[]) => {
    for (const node of list) sort(node.children);
    list.sort((a, b) => rank(a) - rank(b) || a.agent.name.localeCompare(b.agent.name));
  };
  const groups = new Map<string, Node[]>();
  for (const root of roots) groups.set(root.agent.cwd, [...(groups.get(root.agent.cwd) ?? []), root]);
  const result = [...groups].map(([cwd, list]) => { sort(list); return { cwd, nodes: list, rank: Math.min(...list.map(rank)) }; });
  result.sort((a, b) => a.rank - b.rank || basename(a.cwd).localeCompare(basename(b.cwd)));
  return result;
}

export function setupAgentsPanel(options: {
  button: HTMLElement;
  /** Resolves true once the agent is shown; false leaves the overview open. */
  open: (agent: OverviewAgent) => Promise<boolean>;
  /** Called once the overview has closed on an opened agent. */
  focusComposer: () => void;
}) {
  const overlay = document.createElement('div');
  overlay.className = 'agents-overlay hidden';
  const panel = document.createElement('div');
  panel.className = 'agents-panel hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Agents');
  panel.innerHTML = `
    <div class="agents-header">
      <h3>Agents</h3>
      <button type="button" class="icon-btn agents-close" aria-label="Close agents">×</button>
    </div>
    <div class="agents-list"></div>`;
  document.body.append(overlay, panel);
  const list = panel.querySelector<HTMLElement>('.agents-list')!;
  let agents: OverviewAgent[] = [];
  let busy: string | null = null;

  const hide = () => { overlay.classList.add('hidden'); panel.classList.add('hidden'); };
  const show = () => {
    overlay.classList.remove('hidden');
    panel.classList.remove('hidden');
    render();
    (panel.querySelector<HTMLElement>('.agent-row') ?? panel.querySelector<HTMLElement>('.agents-close'))?.focus();
  };
  const isVisible = () => !panel.classList.contains('hidden');
  overlay.addEventListener('click', hide);
  list.addEventListener('keydown', (e) => moveListFocus(e, Array.from(list.querySelectorAll<HTMLElement>('.agent-row'))));
  panel.querySelector('.agents-close')!.addEventListener('click', hide);
  options.button.addEventListener('click', () => (isVisible() ? hide() : show()));

  async function open(muxId: string) {
    const agent = agents.find((item) => item.muxId === muxId);
    if (!agent || busy) return;
    busy = agent.muxId;
    render();
    try {
      if (await options.open(agent)) {
        hide();
        options.focusComposer();
      }
    } finally {
      busy = null;
      render();
    }
  }

  function rows(node: Node, depth: number): HTMLElement[] {
    const { agent } = node;
    const button = element('button', `agent-row agent-${agent.status}${agent.placement === 'worker' ? ' agent-worker' : ''}${busy === agent.muxId ? ' agent-opening' : ''}`);
    button.setAttribute('type', 'button');
    button.setAttribute('style', `--depth:${depth}`);
    button.dataset.muxId = agent.muxId;
    const icon = element('span', 'agent-icon', ICON[agent.status] ?? '·');
    icon.setAttribute('aria-hidden', 'true');
    const name = element('span', 'agent-name', agent.name);
    if (agent.tabId) {
      const tab = element('span', 'agent-tab', 'tab');
      tab.title = 'Open in a Tau tab';
      name.append(tab);
    }
    const text = element('span', 'agent-text');
    text.append(name, element('span', 'agent-detail', agent.detail ? `${agent.status} · ${agent.detail}` : agent.status));
    button.append(icon, text);
    button.addEventListener('click', () => { void open(agent.muxId); });
    return [button, ...node.children.flatMap((child) => rows(child, depth + 1))];
  }

  function groupElement(group: { cwd: string; nodes: Node[] }) {
    const title = element('div', 'agents-group-title');
    title.title = group.cwd;
    title.append(element('span', 'agents-group-name', basename(group.cwd)), element('span', 'agents-group-path', group.cwd));
    const node = element('div', 'agents-group');
    node.append(title, ...group.nodes.flatMap((item) => rows(item, 0)));
    return node;
  }

  function render() {
    const counts = { blocked: 0, working: 0, done: 0 };
    for (const agent of agents) if (agent.status in counts) counts[agent.status as keyof typeof counts]++;
    const urgent = counts.blocked ? 'blocked' : counts.done ? 'done' : counts.working ? 'working' : 'idle';
    options.button.dataset.urgency = agents.length ? urgent : 'none';
    options.button.querySelector('.agents-count')!.textContent = counts.blocked ? `${counts.blocked}` : agents.length ? `${agents.length}` : '';
    options.button.title = agents.length
      ? `Agents: ${counts.blocked} blocked, ${counts.working} working, ${counts.done} done, ${agents.length} total`
      : 'Agents: none shared';
    if (!isVisible()) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.muxId;
    list.replaceChildren(...(agents.length
      ? buildAgentGroups(agents).map(groupElement)
      : [element('div', 'agents-empty', 'No shared agents. Agents started in Emacs through pimux appear here.')]));
    if (focused) list.querySelector<HTMLElement>(`[data-mux-id="${CSS.escape(focused)}"]`)?.focus();
  }

  return {
    update(next: OverviewAgent[]) { agents = next || []; render(); },
    show, hide, isVisible, open,
    count: () => agents.length,
  };
}
