(function () {
  const q = new URLSearchParams(location.search), t = q.get('theme');
  const sys = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t === 'dark' || t === 'light' ? t : sys;
})();
