(function () {
  const THREE_URL = 'https://unpkg.com/three@0.170.0/build/three.module.min.js'; // the same build the viewer loads
  const q = new URLSearchParams(location.search);
  const num = (name, d) => (q.has(name) && isFinite(+q.get(name)) ? +q.get(name) : d);
  const list = (name) => (q.has(name) ? q.get(name).split(',') : null);
  const RAD = Math.PI / 180, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const $ = (id) => document.getElementById(id);
  const state = {
    scene: q.get('scene') || '', theme: document.documentElement.dataset.theme, quality: q.get('quality') === 'low' ? 'low' : 'high',
    season: q.get('season') === 'summer' || q.get('season') === 'winter' ? q.get('season') : undefined,
    view: q.get('view') === 'orbit' ? 'orbit' : 'pov', at: num('at', 0), yaw: num('yaw', 0), pitch: num('pitch', 0), eye: num('eye', 1.6), fov: num('fov', 76),
    orbit: (list('orbit') || [20, 38, 0]).map(Number), cam: list('cam'), look: list('look'),
    sun: list('sun') ? { azimuth: +list('sun')[0], elevation: +list('sun')[1] } : undefined,
    route: q.get('route') !== '0', fog: q.get('fog') !== '0',
    pollard: q.has('pollard') ? q.get('pollard') !== '0' : undefined,
    zShift: q.get('zshift') === 'auto' ? true : num('zshift', 0), flatten: q.get('flatten') === '1', shadows: q.get('shadows') !== '0',
    feather: q.has('feather') ? num('feather', 5) : undefined, featherInside: num('featherinside', 0), featherColor: q.get('feathercolor') ? '#' + q.get('feathercolor') : undefined,
  };
  if (q.get('ui') === '0') { $('head').hidden = true; $('dock').hidden = true; }
  let done, failed;
  window.__ready = new Promise((res, rej) => { done = res; failed = rej; });
  const fail = (text) => {
    const d = document.createElement('div');
    d.className = 'fail'; d.textContent = text;
    document.body.appendChild(d);
    failed(new Error(text));
  };
  const script = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src + '?v=' + Date.now(); s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const loadScene = async () => {
    const want = state.scene ? [state.scene] : ['bern', '_fixture'];
    for (const key of want) {
      try { await script('stations3d/' + key + '.detail.js'); } catch (e) { continue; }
      if (window.STATION3D_DETAIL && window.STATION3D_DETAIL[key]) { state.scene = key; return window.STATION3D_DETAIL[key]; }
    }
    return null;
  };

  Promise.all([import(THREE_URL), script('station3d-detail.js'), loadScene()]).then(([THREE, , detail]) => {
    if (!detail) return fail('This scene could not be loaded. Check that stations3d/' + (state.scene || 'bern') + '.detail.js exists.');
    start(THREE, detail);
  }).catch((e) => fail('The 3D library or the renderer could not be loaded. Check the connection and reload. (' + (e && e.message) + ')'));

  function start(THREE, detail) {
    const canvas = $('gl');
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
    catch (e) { return fail('This browser cannot draw 3D (WebGL is not available).'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(state.fov, 1, 0.2, 900);
    const toScene = (x, y, z) => [x, z, -y];
    const V = (p) => new THREE.Vector3(p[0], p[2], -p[1]);
    let handle = null, sky = null, backdrop = null, routeMesh = null, pal = null;

    // the walk: distances along it
    const path = (detail.path || []).filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
    const dist = [0];
    for (let i = 1; i < path.length; i++) dist.push(dist[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    const total = dist[dist.length - 1] || 0;
    const pointAt = (d) => {
      if (path.length < 2) return { p: path[0] || [0, 0], t: [0, 1] };
      d = clamp(d, 0, total);
      let i = 1;
      while (i < path.length - 1 && dist[i] < d) i++;
      const a = path[i - 1], b = path[i], l = dist[i] - dist[i - 1] || 1, f = (d - dist[i - 1]) / l;
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], t: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
    };
    // the direction of the walk a little ahead and behind, so corners turn the head gently
    const bearingAt = (d) => { const a = pointAt(d - 1.2).p, b = pointAt(d + 2.5).p; return Math.atan2(b[0] - a[0], b[1] - a[1]); };
    const zAt = (x, y, d) => { const z = handle.groundAt(x, y); return z == null ? d || 0 : z; };
    const box = (() => {
      const pts = (detail.area && detail.area.length ? detail.area : path).concat(path);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      return isFinite(x0) ? [x0, y0, x1, y1] : [-20, -20, 20, 20];
    })();
    const mid = path.length ? pointAt(total / 2).p : [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    if (!state.orbit[2]) state.orbit[2] = Math.max(45, total * 1.7);

    function rebuild(change) {
      Object.assign(state, change);
      document.documentElement.dataset.theme = state.theme;
      const opts = { theme: state.theme, quality: state.quality, season: state.season, pollard: state.pollard, zShift: state.zShift, flatten: state.flatten, shadows: state.shadows, feather: state.feather, featherInside: state.featherInside, featherColor: state.featherColor, sun: state.sun, toScene };
      if (handle) Station3DDetail.update(handle, opts); else { handle = Station3DDetail.build(THREE, detail, opts); scene.add(handle.group); }
      pal = Station3DDetail.palette(state.theme);
      if (sky) { scene.remove(sky); sky.geometry.dispose(); sky.material.dispose(); }
      sky = Station3DDetail.sky(THREE, { theme: state.theme, radius: 800 });
      scene.add(sky);
      scene.userData.fog = scene.fog = state.fog ? new THREE.Fog(pal.horizon, 42, 320) : null; // the haze of the viewer's first-person view
      renderer.setClearColor(pal.horizon);
      // what the viewer has around the stretch: plain ground to the horizon
      if (backdrop) { scene.remove(backdrop); backdrop.geometry.dispose(); backdrop.material.dispose(); }
      let z = zAt(mid[0], mid[1]); // below the lowest ground of the scene (a street that falls must not dip into it)
      for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) { const g = handle.groundAt(box[0] + (box[2] - box[0]) * i / 12, box[1] + (box[3] - box[1]) * j / 12); if (g != null) z = Math.min(z, g); }
      z -= 0.45;
      backdrop = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshBasicMaterial({ color: pal.ground }));
      backdrop.rotation.x = -Math.PI / 2; backdrop.position.set(mid[0], z, -mid[1]); backdrop.renderOrder = -50;
      scene.add(backdrop);
      // the route, as the viewer lays it on the ground: a blue band with a darker edge
      if (routeMesh) { scene.remove(routeMesh); routeMesh.geometry.dispose(); routeMesh.material.dispose(); routeMesh = null; }
      if (state.route && path.length > 1) {
        const pos = [], col = [], idx = [], blue = new THREE.Color(state.theme === 'dark' ? '#0A84FF' : '#007AFF'), edge = new THREE.Color(state.theme === 'dark' ? '#0057C2' : '#0A5FCC');
        const n = Math.max(2, Math.ceil(total / 0.12));
        for (let i = 0; i <= n; i++) {
          const o = pointAt(total * i / n), lx = -o.t[1], ly = o.t[0];
          [[-0.5, edge], [-0.41, blue], [0.41, blue], [0.5, edge]].forEach(([w, c]) => {
            const x = o.p[0] + lx * w, y = o.p[1] + ly * w;
            pos.push(x, zAt(x, y, zAt(o.p[0], o.p[1])) + 0.03, -y); col.push(c.r, c.g, c.b);
          });
          if (i < n) for (let k = 0; k < 3; k++) { const a = i * 4 + k; idx.push(a, a + 1, a + 5, a, a + 5, a + 4); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
        routeMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16 }));
        routeMesh.renderOrder = 6;
        scene.add(routeMesh);
      }
      const s = handle.stats;
      $('name').textContent = detail.name || state.scene;
      $('stat').textContent = s.triangles.toLocaleString('en') + ' triangles in ' + s.drawCalls + ' draw calls, built in ' + s.buildMs + ' ms' + (s.warnings.length ? ' · ' + s.warnings.length + ' warnings' : '');
      $('bNight').setAttribute('aria-pressed', String(state.theme === 'dark'));
      $('bLow').setAttribute('aria-pressed', String(state.quality === 'low'));
      const bare = state.season ? state.season === 'winter' : (detail.trees || []).some((t) => t && t.leaves === false);
      $('bLeaves').setAttribute('aria-pressed', String(!bare));
      window.__stats = s;
      if (s.warnings.length) console.warn('detail warnings: ' + s.warnings.join(' | '));
      draw();
    }

    function place() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.fov = state.fov; camera.updateProjectionMatrix();
      if (state.cam && state.look) {
        const P = (a) => { const x = +a[0], y = +a[1]; return [x, y, String(a[2]).startsWith('+') ? zAt(x, y) + +a[2] : +a[2]]; };
        camera.position.copy(V(P(state.cam))); camera.lookAt(V(P(state.look)));
      } else if (state.view === 'orbit') {
        const az = state.orbit[0] * RAD, el = clamp(state.orbit[1], 4, 89) * RAD, d = state.orbit[2], z = zAt(mid[0], mid[1]);
        camera.position.set(mid[0] - Math.sin(az) * Math.cos(el) * d, z + Math.sin(el) * d, -(mid[1] - Math.cos(az) * Math.cos(el) * d));
        camera.lookAt(mid[0], z + 2, -mid[1]);
      } else {
        const o = pointAt(state.at), b = bearingAt(state.at) + state.yaw * RAD, ph = clamp(state.pitch, -85, 85) * RAD;
        const z = zAt(o.p[0], o.p[1]) + state.eye;
        camera.position.set(o.p[0], z, -o.p[1]);
        camera.lookAt(o.p[0] + Math.sin(b) * Math.cos(ph), z + Math.sin(ph), -(o.p[1] + Math.cos(b) * Math.cos(ph)));
      }
      if (sky) sky.position.copy(camera.position);
      if (scene.userData.fog !== undefined) scene.fog = state.view === 'orbit' && !(state.cam && state.look) ? null : scene.userData.fog; // the haze belongs to the walk, not to the view from above
    }
    let queued = false;
    function draw() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        place();
        renderer.render(scene, camera);
        window.__info = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        $('at').textContent = state.view === 'orbit' ? 'Overview' : state.at.toFixed(1);
        $('of').textContent = state.view === 'orbit' ? '' : 'of ' + Math.round(total) + ' m';
        $('scrub').value = state.at;
        $('bView').setAttribute('aria-pressed', String(state.view === 'orbit'));
        $('tape').hidden = state.view === 'orbit';
      });
    }
    const set = (change) => { Object.assign(state, change); state.at = clamp(state.at, 0, total); draw(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };

    // the tape
    const scrub = $('scrub');
    scrub.max = total || 1;
    $('ticks').style.backgroundSize = (500 / (total || 1)) + '% 16px, ' + (100 / (total || 1)) + '% 8px';
    for (let m = 0; m <= total + 0.01; m += 5) { const s = document.createElement('span'); s.textContent = m; s.style.left = (m / (total || 1) * 100) + '%'; $('nums').appendChild(s); }
    scrub.addEventListener('input', () => set({ at: +scrub.value, cam: null, look: null }));
    $('bView').onclick = () => set({ view: state.view === 'orbit' ? 'pov' : 'orbit', cam: null, look: null });
    $('bNight').onclick = () => rebuild({ theme: state.theme === 'dark' ? 'light' : 'dark' });
    $('bLow').onclick = () => rebuild({ quality: state.quality === 'low' ? 'high' : 'low' });
    $('bLeaves').onclick = () => rebuild({ season: $('bLeaves').getAttribute('aria-pressed') === 'true' ? 'winter' : 'summer' });

    // drag to look around (walk view) or to turn the scene (overview); wheel and pinch zoom the overview
    const pointers = new Map();
    let pinch = 0;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); canvas.focus(); });
    canvas.addEventListener('pointermove', (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const dx = e.clientX - last[0], dy = e.clientY - last[1];
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch && state.view === 'orbit') state.orbit[2] = clamp(state.orbit[2] * pinch / d, 12, 400);
        pinch = d;
      } else if (state.view === 'orbit') { state.orbit[0] -= dx * 0.35; state.orbit[1] = clamp(state.orbit[1] + dy * 0.25, 6, 88); }
      else { state.yaw -= dx * 0.22; state.pitch = clamp(state.pitch + dy * 0.18, -70, 80); state.cam = null; }
      draw();
    });
    const up = (e) => { pointers.delete(e.pointerId); pinch = 0; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (state.view === 'orbit') state.orbit[2] = clamp(state.orbit[2] * Math.exp(e.deltaY * 0.001), 12, 400); else state.at = clamp(state.at - e.deltaY * 0.01, 0, total); draw(); }, { passive: false });
    window.addEventListener('keydown', (e) => {
      const k = e.key;
      if (e.target === scrub && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
      if (k === 'ArrowUp') state.at = clamp(state.at + (e.shiftKey ? 0.2 : 1), 0, total);
      else if (k === 'ArrowDown') state.at = clamp(state.at - (e.shiftKey ? 0.2 : 1), 0, total);
      else if (k === 'ArrowLeft') { if (state.view === 'orbit') state.orbit[0] -= 6; else state.yaw -= 6; }
      else if (k === 'ArrowRight') { if (state.view === 'orbit') state.orbit[0] += 6; else state.yaw += 6; }
      else return;
      state.cam = null;
      e.preventDefault();
      draw();
    });
    window.addEventListener('resize', draw);

    try { rebuild({}); } catch (e) { console.error(e); return fail('The scene could not be built: ' + (e && e.message)); }
    window.DEV = { state, set, rebuild: (c) => { rebuild(c); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, handle: () => handle, THREE, scene, camera, renderer, pointAt, total };
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done(Object.assign({ scene: state.scene }, handle.stats, window.__info)))));
  }
})();
