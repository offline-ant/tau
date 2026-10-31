/** Markdown message and assistant-step rendering. Grouping lives in AssistantBlocks. */
import { renderMarkdown, renderUserMarkdown } from './markdown.js';

import type { AssistantStep } from './app-types.js';
type RenderedImage = { data: string; mimeType?: string };
type UserMessage = { content?: string; images?: RenderedImage[] };

export class MessageRenderer {
  container: HTMLElement;
  isNearBottom = true;
  /** Streamed text not drawn yet: a delta only grows this, and the DOM follows once per frame. */
  private pendingSteps = new Map<HTMLElement, string>();
  private stepFrame = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.addEventListener('scroll', () => {
      this.isNearBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 100;
    });
  }

  clear() {
    this.pendingSteps.clear();
    this.container.innerHTML = '';
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Tau</p>
        <p class="hint">Open an agent or a session from the sidebar, or create a Tau tab with +.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message: UserMessage, isHistory = false, target: ParentNode = this.container) {
    this.container.querySelector('.welcome')?.remove();
    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;
    const imagesHtml = message.images?.length ? '<div class="message-images">' + message.images.map(img => {
      const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
      return `<img class="message-image" src="${src.replace(/"/g, '&quot;')}" alt="Attached image" />`;
    }).join('') + '</div>' : '';
    div.innerHTML = `<div class="message-content">${imagesHtml}${renderUserMarkdown(message.content || '')}</div>`;
    this.setupCopyButton(div);
    target.appendChild(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantStep(step: AssistantStep, streaming = false) {
    const element = document.createElement('div');
    element.className = 'assistant-step';
    const content = document.createElement('div');
    content.className = 'assistant-step-content';
    if (step.type === 'thinking') {
      content.classList.add('thinking-block');
      const label = document.createElement('div');
      label.className = 'thinking-label';
      label.textContent = 'Thinking';
      const thinking = document.createElement('div');
      thinking.className = 'thinking-content';
      content.append(label, thinking);
    }
    element.append(content);
    this.updateAssistantStep(element, step.text, streaming);
    return element;
  }

  /** Latest text of a step, drawn or not. */
  assistantStepText(element: HTMLElement) {
    return this.pendingSteps.get(element) ?? element.querySelector<HTMLElement>('.assistant-step-content')?.dataset.rawText ?? '';
  }

  /**
   * Records a streamed update and draws it on the next frame. Drawing renders
   * the whole step, so doing it per delta makes a long reply quadratic and a
   * phone fall ever further behind the stream.
   */
  queueAssistantStep(element: HTMLElement, text: string) {
    this.pendingSteps.set(element, text);
    if (this.stepFrame) return;
    this.stepFrame = requestAnimationFrame(() => {
      this.stepFrame = 0;
      for (const [step, pending] of this.pendingSteps) this.updateAssistantStep(step, pending, true);
      this.scrollToBottom();
    });
  }

  updateAssistantStep(element: HTMLElement, text: string, streaming = false) {
    this.pendingSteps.delete(element);
    const content = element.querySelector<HTMLElement>('.assistant-step-content')!;
    content.dataset.rawText = text;
    content.classList.toggle('streaming', streaming);
    const thinking = content.querySelector('.thinking-content');
    if (thinking) thinking.textContent = text;
    else content.innerHTML = renderMarkdown(text);
    if (!streaming) this.setupCopyButton(element);
  }

  renderCompaction(summary?: string, target: ParentNode = this.container) {
    const element = document.createElement('div');
    element.className = 'system-message compaction-message compaction-done';
    element.textContent = `Context compacted${summary ? ` — ${summary}` : ''}`;
    target.appendChild(element);
    return element;
  }

  renderSystemMessage(text: string) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = String(text ?? '');
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  /** A final provider failure is a visible activity step, never thinking text. */
  renderAssistantError(errorMessage: string) {
    const element = this.renderAssistantStep({ type: 'text', text: '' });
    const error = document.createElement('div');
    error.className = 'message-error';
    const title = document.createElement('div');
    title.className = 'message-error-title';
    title.textContent = 'Request failed';
    const detail = document.createElement('div');
    detail.className = 'message-error-detail';
    detail.textContent = errorMessage;
    error.append(title, detail);
    element.querySelector('.assistant-step-content')!.append(error);
    return element;
  }

  renderError(errorMessage: string) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  /** News about the session, not a failure. */
  renderNotice(message: string) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = message;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  private setupCopyButton(messageEl: HTMLElement) {
    if (messageEl.querySelector('.message-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'message-copy-btn';
    btn.setAttribute('aria-label', 'Copy message');
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content, .assistant-step-content')!;
      const text = content.textContent || '';
      const copyText = (value: string) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(value);
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      });
    });
    messageEl.append(btn);
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => { this.container.scrollTop = this.container.scrollHeight; });
    }
  }
}
