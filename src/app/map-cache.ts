// Keeps the base map on this device: registers the service worker (src/sw/sw.ts → dist/sw.js) that stores
// swisstopo's tiles, satellite photos, fonts and styles, so places already looked at draw at once when you come
// back, also in a later visit. Registered after the page has loaded, so it never competes with the first map view.

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => {
    // relative: on GitHub Pages the site is in a folder (/<repo>/), and the worker covers that folder.
    // updateViaCache 'none': a new sw.js is picked up on the next visit, not once the HTTP cache lets go of the old one.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
