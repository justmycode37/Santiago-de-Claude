(function () {
  const THREE_URL = 'https://unpkg.com/three@0.170.0/build/three.module.min.js'; // the same build the viewer loads
  const q = new URLSearchParams(location.search);
  const num = (name: string, d: number) => (q.has(name) && isFinite(+q.get(name)!) ? +q.get(name)! : d);
  const list = (name: string) => (q.has(name) ? q.get(name)!.split(',') : null);
  const RAD = Math.PI / 180, clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const $ = (id: string) => document.getElementById(id)!;
  /** A place for the free camera: [x, y, z] in model metres; a z written "+1.6" is that far above the ground there. */
  type DevSpot = (string | number)[];
  /** The look and the view: from the URL, then changed by the buttons, the pointer, the keys and DEV.set() / DEV.rebuild(). */
  interface DevState {
    /** The key of the scene (stations3d/<key>.detail.js). */
    scene: string;
    theme: Station3DDetailTheme;
    quality: Station3DDetailQuality;
    season?: Station3DDetailSeason;
    view: 'orbit' | 'pov';
    /** The walk view: metres along the walk, the head in degrees, the eye height in metres. */
    at: number; yaw: number; pitch: number; eye: number;
    fov: number;
    /** The overview: the bearing and the height of the camera in degrees, its distance in metres. */
    orbit: number[];
    /** The free camera, when both are set. */
    cam: DevSpot | null; look: DevSpot | null;
    sun?: { azimuth: number; elevation: number };
    route: boolean; fog: boolean;
    pollard?: boolean;
    zShift: number | boolean; flatten: boolean; shadows: boolean;
    feather?: number; featherInside: number; featherColor?: string;
  }
  /** What the last frame took to draw. */
  interface DevInfo { calls: number; triangles: number }
  /** What window.__ready resolves with once the first frame is drawn. */
  type DevReady = { scene: string } & Station3DDetailStats & DevInfo;
  /** A point of the walk and the direction of the walk there. */
  interface DevPoint { p: number[]; t: number[] }
  type DevMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** `DEV.tram` (tram=1). */
  interface DevTram {
    vehicle: Station3DDetailVehicle;
    path: XY[];
    /** Metres along `path` where the front stands when the tram is at the platform. */
    stop: number;
    /** Open, close, or (without an argument) the other of the two. */
    doors(open?: boolean | null): void;
    arrive(seconds?: number): Promise<void>;
    depart(seconds?: number): Promise<void>;
  }
  /** window.DEV: what the page offers to the console and to the scripts that drive it. */
  interface Dev {
    tram?: DevTram;
    state: DevState;
    set(change: Partial<DevState>): Promise<unknown>;
    rebuild(change: Partial<DevState>): Promise<unknown>;
    handle(): Station3DDetailHandle | null;
    THREE: ThreeModule;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    pointAt(d: number): DevPoint;
    total: number;
  }
  type DevWindow = typeof window & { __ready: Promise<DevReady>; __stats: Station3DDetailStats; __info: DevInfo; DEV: Dev };
  const state: DevState = {
    scene: q.get('scene') || '', theme: document.documentElement.dataset.theme as Station3DDetailTheme, quality: q.get('quality') === 'low' ? 'low' : 'high',
    season: q.get('season') === 'summer' || q.get('season') === 'winter' ? q.get('season') as Station3DDetailSeason : undefined,
    view: q.get('view') === 'orbit' ? 'orbit' : 'pov', at: num('at', 0), yaw: num('yaw', 0), pitch: num('pitch', 0), eye: num('eye', 1.6), fov: num('fov', 76),
    orbit: (list('orbit') || [20, 38, 0]).map(Number), cam: list('cam'), look: list('look'),
    sun: list('sun') ? { azimuth: +list('sun')![0], elevation: +list('sun')![1] } : undefined,
    route: q.get('route') !== '0', fog: q.get('fog') !== '0',
    pollard: q.has('pollard') ? q.get('pollard') !== '0' : undefined,
    zShift: q.get('zshift') === 'auto' ? true : num('zshift', 0), flatten: q.get('flatten') === '1', shadows: q.get('shadows') !== '0',
    feather: q.has('feather') ? num('feather', 5) : undefined, featherInside: num('featherinside', 0), featherColor: q.get('feathercolor') ? '#' + q.get('feathercolor') : undefined,
  };
  if (q.get('ui') === '0') { $('head').hidden = true; $('dock').hidden = true; }
  let done: (stats: DevReady) => void, failed: (e: Error) => void;
  (window as DevWindow).__ready = new Promise((res, rej) => { done = res; failed = rej; });
  const fail = (text: string) => {
    const d = document.createElement('div');
    d.className = 'fail'; d.textContent = text;
    document.body.appendChild(d);
    failed(new Error(text));
  };
  const script = (src: string) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src + '?v=' + Date.now(); s.onload = res; s.onerror = rej; document.head.appendChild(s); });
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

  // The pieces of track joined into one line that passes `near`, driving with `near` on the right.
  // Returns the line and how far along it `near` is.
  function tramPath(tracks: XY[][], near: number[]): { path: XY[]; at: number } | null {
    const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const foot = (p: number[], a: number[], b: number[]) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)); return { t, d: Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t) }; };
    const lineD = (l: XY[]) => { let d = Infinity; for (let i = 0; i + 1 < l.length; i++) d = Math.min(d, foot(near, l[i], l[i + 1]).d); return d; };
    const rest = tracks.filter((l) => l.length > 1).map((l) => l.slice()).sort((a, b) => lineD(a) - lineD(b));
    if (!rest.length) return null;
    let line = rest.shift()!;
    const dir = (a: number[], b: number[]) => { const l = gap(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    const goesOn = (u: number[], w: number[]) => u[0] * w[0] + u[1] * w[1] > 0.8;
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i], n = line.length, m = l.length, e = dir(line[n - 2], line[n - 1]), s = dir(line[1], line[0]);
        let made: XY[] | null = null;
        if (gap(line[n - 1], l[0]) < 2 && goesOn(e, dir(l[0], l[1]))) made = line.concat(l);
        else if (gap(line[n - 1], l[m - 1]) < 2 && goesOn(e, dir(l[m - 1], l[m - 2]))) made = line.concat(l.slice().reverse());
        else if (gap(line[0], l[m - 1]) < 2 && goesOn(s, dir(l[m - 1], l[m - 2]))) made = l.concat(line);
        else if (gap(line[0], l[0]) < 2 && goesOn(s, dir(l[0], l[1]))) made = l.slice().reverse().concat(line);
        if (made) { line = made; rest.splice(i, 1); again = true; break; }
      }
    }
    const where = () => { let best: { d: number; at: number; i: number } | null = null, s = 0; for (let i = 0; i + 1 < line.length; i++) { const f = foot(near, line[i], line[i + 1]), l = gap(line[i], line[i + 1]); if (!best || f.d < best.d) best = { d: f.d, at: s + f.t * l, i }; s += l; } return best!; };
    let w = where();
    const a = line[w.i], b = line[w.i + 1];
    if ((b[0] - a[0]) * (near[1] - a[1]) - (b[1] - a[1]) * (near[0] - a[0]) > 0) { line.reverse(); w = where(); }
    return { path: line, at: w.at };
  }

  function start(THREE: ThreeModule, detail: StationDetailModel) {
    const canvas = $('gl') as HTMLCanvasElement;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
    catch (e) { return fail('This browser cannot draw 3D (WebGL is not available).'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(state.fov, 1, 0.2, 900);
    const toScene = (x: number, y: number, z: number): [number, number, number] => [x, z, -y];
    const V = (p: number[]) => new THREE.Vector3(p[0], p[2], -p[1]);
    let handle: Station3DDetailHandle | null = null, sky: Station3DDetailSky | null = null, backdrop: DevMesh | null = null, routeMesh: DevMesh | null = null, pal: Station3DDetailPalette | null = null;

    // the walk: distances along it
    const path = (detail.path || []).filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
    const dist = [0];
    for (let i = 1; i < path.length; i++) dist.push(dist[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    const total = dist[dist.length - 1] || 0;
    const pointAt = (d: number): DevPoint => {
      if (path.length < 2) return { p: path[0] || [0, 0], t: [0, 1] };
      d = clamp(d, 0, total);
      let i = 1;
      while (i < path.length - 1 && dist[i] < d) i++;
      const a = path[i - 1], b = path[i], l = dist[i] - dist[i - 1] || 1, f = (d - dist[i - 1]) / l;
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], t: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
    };
    // the direction of the walk a little ahead and behind, so corners turn the head gently
    const bearingAt = (d: number) => { const a = pointAt(d - 1.2).p, b = pointAt(d + 2.5).p; return Math.atan2(b[0] - a[0], b[1] - a[1]); };
    const zAt = (x: number, y: number, d?: number) => { const z = handle!.groundAt(x, y); return z == null ? d || 0 : z; };
    const box = (() => {
      const pts = (detail.area && detail.area.length ? detail.area as number[][] : path).concat(path);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      return isFinite(x0) ? [x0, y0, x1, y1] : [-20, -20, 20, 20];
    })();
    const mid = path.length ? pointAt(total / 2).p : [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    if (!state.orbit[2]) state.orbit[2] = Math.max(45, total * 1.7);

    function rebuild(change: Partial<DevState>) {
      Object.assign(state, change);
      document.documentElement.dataset.theme = state.theme;
      const opts: Station3DDetailOptions = { theme: state.theme, quality: state.quality, season: state.season, pollard: state.pollard, zShift: state.zShift, flatten: state.flatten, shadows: state.shadows, feather: state.feather, featherInside: state.featherInside, featherColor: state.featherColor, sun: state.sun, toScene };
      if (handle) Station3DDetail!.update(handle, opts); else { handle = Station3DDetail!.build(THREE, detail, opts); scene.add(handle.group); }
      pal = Station3DDetail!.palette(state.theme);
      if (sky) { scene.remove(sky); sky.geometry.dispose(); sky.material.dispose(); }
      sky = Station3DDetail!.sky(THREE, { theme: state.theme, radius: 800 });
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
        const pos: number[] = [], col: number[] = [], idx: number[] = [], blue = new THREE.Color(state.theme === 'dark' ? '#0A84FF' : '#007AFF'), edge = new THREE.Color(state.theme === 'dark' ? '#0057C2' : '#0A5FCC');
        const n = Math.max(2, Math.ceil(total / 0.12));
        for (let i = 0; i <= n; i++) {
          const o = pointAt(total * i / n), lx = -o.t[1], ly = o.t[0];
          ([[-0.5, edge], [-0.41, blue], [0.41, blue], [0.5, edge]] as [number, THREE.Color][]).forEach(([w, c]) => {
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
      (window as DevWindow).__stats = s;
      if (s.warnings.length) console.warn('detail warnings: ' + s.warnings.join(' | '));
      draw();
    }

    function place() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.fov = state.fov; camera.updateProjectionMatrix();
      if (state.cam && state.look) {
        const P = (a: DevSpot) => { const x = +a[0], y = +a[1]; return [x, y, String(a[2]).startsWith('+') ? zAt(x, y) + +a[2] : +a[2]]; };
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
        (window as DevWindow).__info = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        $('at').textContent = state.view === 'orbit' ? 'Overview' : state.at.toFixed(1);
        $('of').textContent = state.view === 'orbit' ? '' : 'of ' + Math.round(total) + ' m';
        ($('scrub') as HTMLInputElement).value = state.at as unknown as string;
        $('bView').setAttribute('aria-pressed', String(state.view === 'orbit'));
        $('tape').hidden = state.view === 'orbit';
      });
    }
    const set = (change: Partial<DevState>) => { Object.assign(state, change); state.at = clamp(state.at, 0, total); draw(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };

    // the tape
    const scrub = $('scrub') as HTMLInputElement;
    scrub.max = (total || 1) as unknown as string;
    $('ticks').style.backgroundSize = (500 / (total || 1)) + '% 16px, ' + (100 / (total || 1)) + '% 8px';
    for (let m = 0; m <= total + 0.01; m += 5) { const s = document.createElement('span'); s.textContent = m as unknown as string; s.style.left = (m / (total || 1) * 100) + '%'; $('nums').appendChild(s); }
    scrub.addEventListener('input', () => set({ at: +scrub.value, cam: null, look: null }));
    $('bView').onclick = () => set({ view: state.view === 'orbit' ? 'pov' : 'orbit', cam: null, look: null });
    $('bNight').onclick = () => rebuild({ theme: state.theme === 'dark' ? 'light' : 'dark' });
    $('bLow').onclick = () => rebuild({ quality: state.quality === 'low' ? 'high' : 'low' });
    $('bLeaves').onclick = () => rebuild({ season: $('bLeaves').getAttribute('aria-pressed') === 'true' ? 'winter' : 'summer' });

    // drag to look around (walk view) or to turn the scene (overview); wheel and pinch zoom the overview
    const pointers = new Map<number, [number, number]>();
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
    const up = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch = 0; };
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

    try { rebuild({}); } catch (e) { console.error(e); return fail('The scene could not be built: ' + (e && (e as Error).message)); }
    (window as DevWindow).DEV = { state, set, rebuild: (c) => { rebuild(c); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, handle: () => handle, THREE, scene, camera, renderer, pointAt, total };
    const built = handle!; // rebuild() made it
    // tram=1: a tram on the track beside the end of the walk, the platform on its right (where its doors are)
    if (q.get('tram') === '1') {
      const tp = tramPath(built.tracks(), path.length ? path[path.length - 1] : mid);
      if (tp) {
        const v = built.addVehicle({ kind: 'tram', line: q.get('line') || '9', path: tp.path });
        const stop = tp.at + v.length / 2, wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        let open = false, step = 0;
        const tram: DevTram = (window as DevWindow).DEV.tram = {
          vehicle: v, path: tp.path, stop,
          doors: (o) => { open = o == null ? !open : !!o; v.doors(open); },
          arrive: (sec) => { tram.doors(false); return v.run({ from: stop - 75, to: stop, seconds: sec || 9, ease: 'arrive' }); },
          depart: async (sec) => { if (open) { tram.doors(false); await wait(1000); } return v.run({ from: v.at, to: v.at + 90, seconds: sec || 10, ease: 'depart' }); },
        };
        v.place(stop);
        // the page draws on demand; while the tram moves, every frame
        const loop = (now: number) => { if (built.tick(now)) draw(); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        const next = () => { step = (step + 1) % 3; if (step === 1) tram.arrive().then(() => tram.doors(true)); else if (step === 2) tram.depart(); else { v.place(stop); tram.doors(false); draw(); } };
        $('bTram').hidden = false; $('bTram').onclick = next;
        window.addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if (k === 't') tram.arrive(); else if (k === 'g') tram.depart(); else if (k === 'o') tram.doors(); });
        draw();
      } else console.warn('tram=1: this scene has no tram-track surface');
    }
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done(Object.assign({ scene: state.scene }, handle!.stats, (window as DevWindow).__info)))));
  }
})();
