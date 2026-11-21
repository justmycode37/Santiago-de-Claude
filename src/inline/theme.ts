// Pick the theme before first paint: saved choice, else the system setting
(function () {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  const sys = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : sys;
})();
