// Pi extension for the pimux e2e test: inference stays inside Pi's faux
// providers, so no real provider is ever called.
import fs from 'node:fs';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** Holds a reply until the test creates `$FX_HOLD_DIR/<name>`, so "busy" is exact. */
async function hold(name: string) {
  const file = path.join(process.env.FX_HOLD_DIR ?? '', name);
  while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 20));
}

export default function pimuxFaux(pi: ExtensionAPI): void {
  const lastUserText = (context: TranscriptContext): string => {
    const message = [...context.messages].reverse().find((item) => item.role === 'user');
    if (!message || message.role !== 'user') return '';
    return typeof message.content === 'string' ? message.content
      : message.content.map((item) => item.type === 'text' ? item.text : '').join('\n');
  };
  const respond = async (context: TranscriptContext) => {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') return fauxAssistantMessage(`tool done: ${last.toolName}`);
    const text = lastUserText(context);
    const worker = /^run worker (\S+)/.exec(text);
    if (worker) return fauxAssistantMessage([fauxToolCall('do', { task: `hold ${worker[1]}, then report back` })], { stopReason: 'toolUse' });
    if (text.startsWith('ask with a tool')) return fauxAssistantMessage([fauxToolCall('fx_ask', {})], { stopReason: 'toolUse' });
    const held = /\bhold (\S+?),? /.exec(`${text} `);
    if (held) await hold(held[1]);
    if (text.startsWith('big reply')) return fauxAssistantMessage(`${`${'word '.repeat(15)}\n`.repeat(5500)}BIG-END`);
    const stream = /^stream (\d+)/.exec(text);
    if (stream) return fauxAssistantMessage(Array.from({ length: Number(stream[1]) }, (_, index) => `word${index}`).join(' '));
    return fauxAssistantMessage(`reply: ${text}`);
  };
  // `tau-fx` answers at once; `tau-fx-slow` streams slowly enough to join mid-reply.
  for (const [name, tokensPerSecond] of [['tau-fx', undefined], ['tau-fx-slow', 60]] as const) {
    const provider = fauxProvider({ provider: name, models: [{ id: 'one', reasoning: false }, { id: 'deep', reasoning: true }], tokensPerSecond, tokenSize: { min: 1, max: 1 } });
    provider.setResponses(Array.from({ length: 200 }, () => respond));
    pi.registerProvider(provider.provider);
  }
  pi.on('before_agent_start', (_event, ctx) => {
    if (!ctx.model?.provider.startsWith('tau-fx')) throw new Error('pimux e2e fixture refuses non-faux providers');
  });
  pi.registerTool(defineTool({
    name: 'fx_ask', label: 'Ask', description: 'Ask a dialog inside a run', parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const choice = await ctx.ui.select('Pick a colour', ['red', 'blue']);
      return { content: [{ type: 'text', text: `picked ${choice ?? 'none'}` }], details: {} };
    },
  }));
  pi.registerCommand('fx-tree', {
    description: 'Move the selected branch without adding a persistence marker',
    handler: async (target, ctx) => {
      const result = await ctx.navigateTree(target.trim(), { summarize: false });
      if (result.cancelled) throw new Error('Fixture branch move was cancelled');
    },
  });
  pi.registerCommand('fx-two', {
    description: 'Ask two dialogs at once',
    handler: async (_args, ctx) => {
      const choices = await Promise.all([ctx.ui.select('Fruit one', ['apple', 'pear']), ctx.ui.select('Fruit two', ['plum', 'fig'])]);
      ctx.ui.notify(`both:${choices.join(',')}`, 'info');
    },
  });
  pi.registerCommand('fx-status', {
    description: 'Show a status, which asks nothing of anyone',
    handler: async (_args, ctx) => { ctx.ui.setStatus('fx', 'busy with something'); },
  });
  pi.registerCommand('fx-confirm', {
    description: 'Ask a confirmation',
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm('Really?', 'This is the confirmation message.');
      ctx.ui.notify(`confirmed:${confirmed}`, 'info');
    },
  });
  pi.registerCommand('fx-input', {
    description: 'Ask for a line of text',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input('Your name?', 'type here');
      ctx.ui.notify(`input:${value ?? 'none'}`, 'info');
    },
  });
  pi.registerCommand('fx-editor', {
    description: 'Ask for multiline text',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.editor('Edit this', 'line one\nline two');
      ctx.ui.notify(`editor:${value ?? 'none'}`, 'info');
    },
  });
  pi.registerCommand('fx-select', {
    description: 'Ask a select dialog',
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select('Pick a fruit', ['apple', 'pear']);
      ctx.ui.notify(`picked:${choice ?? 'none'}`, 'info');
    },
  });
}
