(function () {
  const q = new URLSearchParams(location.search);
  const sys = window.matchMedia as typeof matchMedia | undefined && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const t = q.get('theme');
  document.documentElement.dataset.theme = t === 'dark' || t === 'light' ? t : sys;
})();
