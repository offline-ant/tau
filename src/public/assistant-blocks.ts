/** Visual grouping shared by live events and saved history. All item DOM is eager. */
type AssistantBlock = {
  element: HTMLElement;
  toggle: HTMLButtonElement;
  items: HTMLElement;
  labels: string[];
  nonThinkingLabels: string[];
};

export class AssistantBlocks {
  private current: AssistantBlock | null = null;
  private blocks: AssistantBlock[] = [];
  private working = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  private container: HTMLElement;

  append(item: HTMLElement, label: string, before: HTMLElement | null = null) {
    if (!this.current) {
      this.container.querySelector('.welcome')?.remove();
      const element = document.createElement('div');
      element.className = 'message assistant assistant-block';
      element.classList.toggle('working', this.working);
      const bubble = document.createElement('div');
      bubble.className = 'message-content';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'assistant-block-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        const expanded = element.classList.toggle('expanded');
        toggle.setAttribute('aria-expanded', String(expanded));
      });
      const items = document.createElement('div');
      items.className = 'assistant-block-items';
      bubble.append(toggle, items);
      element.append(bubble);
      this.container.append(element);
      this.current = { element, toggle, items, labels: [], nonThinkingLabels: [] };
      this.blocks.push(this.current);
    }
    item.classList.add('assistant-block-item');
    item.dataset.label = label;
    this.current.items.insertBefore(item, before);
    if (before) {
      // A client attaching mid-message may receive an earlier block only in
      // the authoritative message_end payload. Restore its original order.
      this.current.labels = Array.from(this.current.items.children, child => (child as HTMLElement).dataset.label!);
      this.current.nonThinkingLabels = this.current.labels.filter(value => value !== 'thinking');
    } else {
      this.current.labels.push(label);
      if (label !== 'thinking') this.current.nonThinkingLabels.push(label);
    }
    this.refresh(this.current);
  }

  setWorking(working: boolean) {
    this.working = working;
    if (this.current) {
      this.current.element.classList.toggle('working', working);
      this.refresh(this.current);
    }
  }

  /** User messages and compaction are boundaries, not tool-round turn_end. */
  boundary() {
    if (this.current) {
      this.current.element.classList.remove('working');
      this.refresh(this.current);
      this.current = null;
    }
  }

  setExpanded(expanded: boolean) {
    for (const block of this.blocks) {
      block.element.classList.toggle('expanded', expanded);
      block.toggle.setAttribute('aria-expanded', String(expanded));
    }
  }

  refreshThinking() {
    for (const block of this.blocks) this.refresh(block);
  }

  clear() {
    this.current = null;
    this.blocks = [];
    this.working = false;
  }

  private refresh(block: AssistantBlock) {
    const labels = document.body.classList.contains('hide-thinking') ? block.nonThinkingLabels : block.labels;
    const earlier = Math.max(0, labels.length - 8);
    block.toggle.textContent = [...(earlier ? [`+${earlier} earlier`] : []), ...labels.slice(-8)].join(' · ');
    block.toggle.hidden = !labels.length || (block.labels.length === 1 && !block.element.classList.contains('working'));
    block.element.classList.toggle('thinking-only', block.nonThinkingLabels.length === 0);
  }
}
