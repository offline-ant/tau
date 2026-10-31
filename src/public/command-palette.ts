import { activateRow, moveListFocus } from './keyboard.js';

type CommandPaletteItem = {
  icon: string;
  label: string;
  desc: string;
  /** Omitted commands always apply; others are left out when they cannot work in the current tab. */
  available?(): boolean;
  action(): void;
};

export function setupCommandPalette(commands: CommandPaletteItem[]) {
  // These elements are part of the app's static index.html shell, so they
  // are present when this setup function runs; assert non-null at the query.
  const commandBtn = document.getElementById('command-btn')!;
  const commandPalette = document.getElementById('command-palette')!;
  const commandPaletteOverlay = document.getElementById('command-palette-overlay')!;
  const commandList = document.getElementById('command-list')!;

  function open() {
    commandList.innerHTML = '';
    commands.filter(cmd => cmd.available?.() ?? true).forEach(cmd => {
      const el = document.createElement('div');
      el.className = 'command-item';
      el.tabIndex = 0;
      el.innerHTML = `
        <div class="command-icon">${cmd.icon}</div>
        <div>
          <div class="command-label">${cmd.label}</div>
          <div class="command-desc">${cmd.desc}</div>
        </div>
      `;
      el.addEventListener('click', () => {
        close();
        cmd.action();
      });
      el.addEventListener('keydown', (e) => activateRow(e, el));
      commandList.appendChild(el);
    });
    commandPalette.classList.remove('hidden');
    commandPaletteOverlay.classList.remove('hidden');
    commandList.querySelector<HTMLElement>('.command-item')?.focus();
  }

  function close() {
    commandPalette.classList.add('hidden');
    commandPaletteOverlay.classList.add('hidden');
  }

  function closeIfOpen() {
    if (commandPalette.classList.contains('hidden')) return false;
    close();
    return true;
  }

  commandBtn.addEventListener('click', open);
  commandList.addEventListener('keydown', (e) => moveListFocus(e, Array.from(commandList.querySelectorAll<HTMLElement>('.command-item'))));
  commandPaletteOverlay.addEventListener('click', close);

  return { close, closeIfOpen };
}
