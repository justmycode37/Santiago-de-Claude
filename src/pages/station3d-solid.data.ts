// data scripts, then the module
(function () {
  const q = new URLSearchParams(location.search);
  const key = q.get('key') || 'zurich';
  const load = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('missing ' + src)); document.head.appendChild(s); });
  window.SOLID_READY = Promise.all([load('stations3d/' + key + '.js'), load('stations3d/' + key + '.solid.js'), load('station-route.js')]).then(() => key);
})();
