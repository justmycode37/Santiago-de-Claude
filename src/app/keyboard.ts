// ---------- Keep the results above the on-screen keyboard ----------
// The list may be as tall as what the keyboard leaves of the screen (.search-wrap's max-height)
import { root } from '../theme.ts';

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const place = () => root.style.setProperty('--vvh', Math.round(vv.height + vv.offsetTop) + 'px');
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    place();
  }
}
