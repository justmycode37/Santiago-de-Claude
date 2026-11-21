// ---------- Keep the bar above the iOS keyboard ----------
if (window.visualViewport) {
  const vv = window.visualViewport;
  const place = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    wrap.style.bottom = kb > 0 ? (kb + 8) + 'px' : '';
    list.style.maxHeight = kb > 0 ? (vv.height - 52 - 40) + 'px' : '';
  };
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
}
