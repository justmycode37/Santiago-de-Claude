const $ = (id) => document.getElementById(id);
const row = (k, v, cls) => { const d = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd');
  dt.textContent = k; dd.textContent = v; if (cls) dd.className = cls; d.append(dt, dd); $('out').append(d); };
const log = (t) => { $('log').textContent += t + '\n'; };
// device facts that decide the speed
row('Cores', navigator.hardwareConcurrency || '?');
row('Memory (approx.)', navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '?');
row('WASM threads', self.crossOriginIsolated ? 'yes' : 'no (static hosting: single thread)');
row('WebGPU', 'gpu' in navigator ? 'available' : 'no');

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  // count frames the page could not draw in time while the engines work
  let last = 0, long = 0, frames = 0, worst = 0, on = true;
  const tick = (t) => { if (last) { const d = t - last; frames++; if (d > 50) long++; worst = Math.max(worst, d); } last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    const img = $('img');
    if (!img.complete || !img.naturalWidth) await new Promise((r, j) => { img.onload = r; img.onerror = () => j(new Error('sample image did not load')); });
    const r = await STOPVISION.bench($('img'), 8, (t) => log(t));
    on = false;
    row('Sign reader load', r.ocrLoadMs + ' ms');
    row('Image model load', r.modelLoadMs + ' ms (' + r.engine + ')');
    row('Photo fingerprint', `${r.photoMs.p50} ms (p95 ${r.photoMs.p95})`, r.photoMs.p50 < 1200 ? 'ok' : 'bad');
    row('Sign reading', `${r.ocrMs.p50} ms (p95 ${r.ocrMs.p95})`, r.ocrMs.p50 < 2500 ? 'ok' : 'bad');
    row('Frames late (> 50 ms)', `${long} of ${frames}, worst ${Math.round(worst)} ms`, long / Math.max(frames, 1) < 0.1 ? 'ok' : 'bad');
    row('Text read', r.text || '(none)');
    const realtime = r.photoMs.p50 < 1200 && r.ocrMs.p50 < 2500 && long / Math.max(frames, 1) < 0.1;
    row('Verdict', realtime ? 'Fast enough for live scanning' : 'Slow: Scan will update less often', realtime ? 'ok' : 'bad');
  } catch (err) {
    on = false;
    log('Failed: ' + (err && err.message || err));
  }
  $('go').disabled = false;
});
