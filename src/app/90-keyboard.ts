// ---------- Keep the results above the on-screen keyboard ----------
// The list may be as tall as what the keyboard leaves of the screen (.search-wrap's max-height)
if (window.visualViewport) {
  const vv = window.visualViewport;
  const place = () => root.style.setProperty('--vvh', Math.round(vv.height + vv.offsetTop) + 'px');
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
  place();
}
