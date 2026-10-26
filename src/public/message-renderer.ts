/** Markdown message and assistant-step rendering. Grouping lives in AssistantBlocks. */
import { renderMarkdown, renderUserMarkdown } from './markdown.js';

import type { AssistantStep } from './app-types.js';
type RenderedImage = { data: string; mimeType?: string };
type UserMessage = { content?: string; images?: RenderedImage[] };

export class MessageRenderer {
  container: HTMLElement;
  isNearBottom = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.addEventListener('scroll', () => {
      this.isNearBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 100;
    });
  }

  clear() {
    this.container.innerHTML = '';
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Tau</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message: UserMessage, isHistory = false) {
    this.container.querySelector('.welcome')?.remove();
    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;
    const imagesHtml = message.images?.length ? '<div class="message-images">' + message.images.map(img => {
      const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
      return `<img class="message-image" src="${src}" alt="Attached image" />`;
    }).join('') + '</div>' : '';
    div.innerHTML = `<div class="message-content">${imagesHtml}${renderUserMarkdown(message.content || '')}</div>`;
    this.setupCopyButton(div);
    this.container.appendChild(div);
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

  updateAssistantStep(element: HTMLElement, text: string, streaming = false) {
    const content = element.querySelector<HTMLElement>('.assistant-step-content')!;
    content.dataset.rawText = text;
    content.classList.toggle('streaming', streaming);
    const thinking = content.querySelector('.thinking-content');
    if (thinking) thinking.textContent = text;
    else content.innerHTML = renderMarkdown(text);
    if (!streaming) this.setupCopyButton(element);
  }

  renderCompaction(summary?: string) {
    const element = document.createElement('div');
    element.className = 'system-message compaction-message compaction-done';
    element.textContent = `Context compacted${summary ? ` — ${summary}` : ''}`;
    this.container.append(element);
    return element;
  }

  renderSystemMessage(text: string) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = String(text ?? '');
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage: string) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
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
