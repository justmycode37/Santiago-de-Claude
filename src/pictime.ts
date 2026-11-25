// When the picture a video element shows now was presented (ms, Date.now() clock). Two reads of the same picture,
// even seconds apart while the video stalls, get the same moment, so the AR camera counts them as one frame
// (src/artrack.ts SAME_FRAME_S) and never as two agreeing frames. Used by Scan's Tesseract (stopvision.ts) and the AR
// camera's PP-OCR (app/ar.ts), which read the same video element. Needs requestVideoFrameCallback (Chrome, Safari
// 15.4+); without it, or for a still image, every read is a new moment (as before).
// (no DOM types: Node's tests use it too)
type FrameVideo = { requestVideoFrameCallback?: (cb: (now: number, meta: { presentationTime?: number }) => void) => number };
const presented = new WeakMap<object, { at: number }>();

function watch(v: FrameVideo) {
  const state = { at: 0 };
  presented.set(v, state);
  const next = () => v.requestVideoFrameCallback!((now, meta) => {
    // presentationTime is on the performance clock: carried over to Date.now()'s
    const p = typeof meta.presentationTime === 'number' ? meta.presentationTime : now;
    state.at = Date.now() - Math.max(0, performance.now() - p);
    next();
  });
  next();
}

export function pictureTime(source: unknown, now = Date.now()): number {
  const v = source as FrameVideo | null;
  if (!v || typeof v.requestVideoFrameCallback !== 'function') return now;
  const s = presented.get(v);
  if (!s) { watch(v); return now; }
  return s.at || now;
}
