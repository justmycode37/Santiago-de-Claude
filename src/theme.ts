// The theme, light or dark: picked before the first paint (src/inline/theme.ts), then changed in Settings
// (src/settings.ts) or by the system's setting (src/app/map-events.ts). The map's style follows it.

export type Theme = 'light' | 'dark';

export const root = document.documentElement;
export const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
export const currentTheme = () => root.dataset.theme === 'dark' ? 'dark' : 'light';

const followers: ((theme: Theme) => void)[] = [];
/** fn(theme) at every change of theme, after the page has taken it (the map's style: src/app/map-events.ts). */
export function onThemeChange(fn: (theme: Theme) => void) { followers.push(fn); }

export function setTheme(theme: Theme, persist: boolean) {
  root.dataset.theme = theme;
  themeMeta.setAttribute('content', getComputedStyle(root).getPropertyValue('--page-bg').trim());
  if (persist) { try { localStorage.setItem('theme', theme); } catch (e) {} }
  for (const fn of followers) fn(theme);
}
