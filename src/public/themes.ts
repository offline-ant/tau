/**
 * Theme system. Telegram (light blue/white) is the default; an explicit choice
 * in Settings is remembered.
 */

export const themes = {
  telegram: {
    name: 'Telegram',
    dark: false,
    colors: ['#ffffff', '#3390ec', '#d7ebfd', '#dfe9f3'],
    vars: {},
  },
  night: {
    name: 'Dusk',
    dark: true,
    colors: ['#212121', '#a0a0a0', '#777777', '#666666'],
    vars: {},
  },
  dawn: {
    name: 'Dawn',
    dark: true,
    colors: ['#1a1d26', '#7a8ab0', '#6a5a80', '#5a7a9a'],
    vars: {},
  },
  midnight: {
    name: 'Midnight',
    dark: true,
    colors: ['#000000', '#5a7a9a', '#4a5565', '#4a5a72'],
    vars: {},
  },
  clean: {
    name: 'Clean',
    dark: false,
    colors: ['#ffffff', '#0580c4', '#007aff', '#5ac8fa'],
    vars: {},
  },
  terracotta: {
    name: 'Terracotta',
    dark: false,
    colors: ['#f4f1ec', '#b06a48', '#5c2860', '#3a6a9b'],
    vars: {},
  },
  sage: {
    name: 'Sage',
    dark: false,
    colors: ['#f0f2ec', '#6a7d5a', '#4a3860', '#3a6a7a'],
    vars: {},
  },
} as const;

export type ThemeId = keyof typeof themes;

const DEFAULT_THEME: ThemeId = 'telegram';
// Written only by an explicit Settings choice, so the default can change.
const THEME_CHOICE_KEY = 'tau-theme-choice';

export function applyTheme(themeId: ThemeId) {
  document.documentElement.setAttribute('data-theme', themeId);
}

export function chooseTheme(themeId: ThemeId) {
  applyTheme(themeId);
  localStorage.setItem(THEME_CHOICE_KEY, themeId);
}

export function getCurrentTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_CHOICE_KEY);
  return saved && saved in themes ? saved as ThemeId : DEFAULT_THEME;
}
