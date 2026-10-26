/** Eager tool details; the surrounding assistant block controls visibility. */
export type ToolArgs = Record<string, unknown>;
export type ToolExecution = {
  toolCallId?: string;
  toolName?: string;
  args?: ToolArgs;
  status?: string;
  output?: string;
  isError?: boolean;
};
type ToolResultBlock = { type?: string; text?: string; [key: string]: unknown };
export type ToolResult = { content?: ToolResultBlock[]; [key: string]: unknown };

export class ToolCardRenderer {
  toolCards = new Map<string, HTMLElement>();

  createToolCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args } = toolExecution;
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = String(toolCallId || '');
    const header = document.createElement('div');
    header.className = 'tool-card-header';
    const left = document.createElement('div');
    left.className = 'tool-header-left';
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = toolName || '';
    const preview = document.createElement('span');
    preview.className = 'tool-args-preview';
    preview.textContent = this.getArgsPreview(args);
    left.append(name, preview);
    const right = document.createElement('div');
    right.className = 'tool-header-right';
    const copy = document.createElement('button');
    copy.className = 'tool-action-btn copy-output-btn';
    copy.title = 'Copy output';
    copy.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    const status = document.createElement('div');
    status.className = 'tool-status';
    right.append(copy, status);
    header.append(left, right);
    const body = document.createElement('div');
    body.className = 'tool-card-body';
    const oldText = args?.oldText || args?.old_text;
    const newText = args?.newText || args?.new_text;
    if ((toolName === 'edit' || toolName === 'Edit') && oldText && newText) {
      body.append(this.renderDiff(String(oldText), String(newText)));
    } else if (args && Object.keys(args).length) {
      const argumentsElement = document.createElement('div');
      argumentsElement.className = 'tool-args';
      argumentsElement.textContent = JSON.stringify(args, null, 2);
      body.append(argumentsElement);
    }
    const output = document.createElement('div');
    output.className = 'tool-output';
    body.append(output);
    copy.addEventListener('click', () => {
      const text = output.textContent;
      if (!text?.trim()) return;
      const copied = navigator.clipboard ? navigator.clipboard.writeText(text) : new Promise<void>(resolve => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.cssText = 'position:fixed;left:-9999px';
        document.body.append(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        resolve();
      });
      copied.then(() => {
        copy.classList.add('copied');
        setTimeout(() => copy.classList.remove('copied'), 1500);
      });
    });
    card.append(header, body);
    this.toolCards.set(String(toolCallId || ''), card);
    this.updateToolCard(toolExecution);
    return card;
  }

  updateToolCard(toolExecution: ToolExecution) {
    const card = this.toolCards.get(String(toolExecution.toolCallId || ''))!;
    const status = card.querySelector('.tool-status')!;
    const value = toolExecution.status || 'pending';
    status.className = `tool-status ${value}`;
    status.textContent = value;
    if (toolExecution.output !== undefined) card.querySelector('.tool-output')!.textContent = toolExecution.output;
  }

  finalizeToolCard(toolCallId: string, result: ToolResult, isError: boolean) {
    const output = result?.content
      ? result.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n')
      : JSON.stringify(result, null, 2);
    this.updateToolCard({ toolCallId, status: isError ? 'error' : 'complete', output });
  }

  private getArgsPreview(args?: ToolArgs) {
    if (!args) return '';
    if (args.path) return String(args.path);
    if (args.command) return String(args.command).substring(0, 80);
    if (args.query) return String(args.query).substring(0, 60);
    if (args.url) return String(args.url);
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value.length) return value.substring(0, 60);
    }
    return '';
  }

  private renderDiff(oldText: string, newText: string) {
    const container = document.createElement('div');
    container.className = 'tool-diff';
    for (const [text, className, prefix] of [[oldText, 'diff-removed', '- '], [newText, 'diff-added', '+ ']]) {
      for (const line of text!.split('\n')) {
        const element = document.createElement('div');
        element.className = `diff-line ${className}`;
        element.textContent = prefix + line;
        container.append(element);
      }
    }
    return container;
  }

  clear() {
    this.toolCards.clear();
  }
}
