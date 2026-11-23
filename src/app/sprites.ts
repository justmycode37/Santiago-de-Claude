// ---- Map symbols drawn on a canvas when MapLibre first needs them (ids: "sg|l|7|Platform|dark", "arr|k|light", …) ----
import { map } from './map.ts';
import { WALK } from './journey-map.ts';
const SPRITE_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const INK = '#14161A';
function spriteCanvas(w: number, h: number, ratio: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * ratio);
  c.height = Math.ceil(h * ratio);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.scale(ratio, ratio);
  return [c, ctx];
}
const spriteOut = (c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, ratio: number): MapSprite => ({ data: ctx.getImageData(0, 0, c.width, c.height), ratio });
function makeSprite(id: string): MapSprite | null {
  const ratio = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
  const p = id.split('|');
  const dark = p[p.length - 1] === 'dark';
  if (p[0] === 'sg') return signSprite(p[2] || '', p.length > 4 ? p[3] : '', dark, ratio);
  if (p[0] === 'arr') return arrowSprite(ratio);
  if (p[0] === 'pin') return fromSprite(ratio);
  if (p[0] === 'lv') return levelSprite(p[1] === 'u', p[2] || '', dark, ratio);
  if (p[0] === 'pl') return placeSprite(p[1], p[2], dark, ratio);
  if (p[0] === 'vh') return vehicleSprite(p[1], '#' + p[2], '#' + p[3], p[4] || '', p[5] === 'x', dark, ratio);
  return null;
}
// A live vehicle: what it is (bus, tram, train, boat, cable car, funicular) as a pictogram in its line's colour;
// with the line number beside it when there is room ("vh|tram|E6331A|FFFFFF|10||light"; "x" marks an extra journey)
const VEHICLE_GLYPH: Record<string, string> = {
  // a train stands on a rail, a bus on wheels, a tram hangs from its wire: told apart even at 12 px
  rail: '<path d="M8 2.5h8a4 4 0 0 1 4 4V15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a4 4 0 0 1 4-4z"/><path d="M4 10h16M8 17l-2 3M16 17l2 3"/><path d="M3 21h18" stroke-width="2.4"/><path d="M8.6 13.6h.01M15.4 13.6h.01" stroke-width="2.6"/>',
  tram: '<rect x="6" y="5.5" width="12" height="11.5" rx="3"/><path d="M6 11.5h12M9.5 20.5l1-3.5M14.5 20.5l-1-3.5M12 5.5V3M9 3h6"/><path d="M9.5 14.2h.01M14.5 14.2h.01" stroke-width="2.6"/>',
  bus: '<rect x="5" y="3.5" width="14" height="13.5" rx="2.5"/><path d="M5 10.5h14M3 6v3.5M21 6v3.5"/><circle cx="8.2" cy="19" r="1.9"/><circle cx="15.8" cy="19" r="1.9"/><path d="M8.6 13.8h.01M15.4 13.8h.01" stroke-width="2.6"/>',
  boat: '<path d="M3 18.5c1.5 1.4 3 1.4 4.5 0s3-1.4 4.5 0 3 1.4 4.5 0 3-1.4 4.5 0M5.2 15l-1-4h15.6l-1 4M8 11V6.5h8V11M12 6.5V4"/>',
  cable: '<path d="M3 5.5l18-2.5M12 4.3V8"/><rect x="7" y="8" width="10" height="10.5" rx="2.5"/><path d="M7 13h10"/>',
  funicular: '<path d="M3 20.5L21 9.5"/><path d="M6.5 16.6V11l9-5.5v5.6"/><path d="M6.5 13.4l9-5.5"/>',
};
// The engine's modes → the glyphs above
export const vehicleGlyph = (mode: string) => (mode === 'rail' || mode === 'rack' ? 'rail' : mode === 'tram' || mode === 'metro' ? 'tram'
  : mode === 'boat' ? 'boat' : mode === 'cableway' || mode === 'lift' ? 'cable' : mode === 'funicular' ? 'funicular' : 'bus');
function vehicleSprite(glyph: string, bg: string, fg: string, label: string, extra: boolean, dark: boolean, ratio: number) {
  const svg = VEHICLE_GLYPH[glyph] || VEHICLE_GLYPH.bus;
  const h = 26, g = 18, m = 4; // height, glyph size, margin for the rim and the shadow
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `800 14px ${SPRITE_FONT}`;
  const tw = label ? probe.measureText(label).width : 0;
  const w = label ? Math.max(h, 5 + g + 4 + tw + 9) : h;
  const [c, ctx] = spriteCanvas(w + m * 2, h + m * 2, ratio);
  const rim = extra ? WALK : dark ? '#0B0D10' : '#FFFFFF', e = extra ? 2.2 : 1.5;
  ctx.shadowColor = 'rgba(8,10,14,.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
  ctx.fillStyle = rim;
  ctx.beginPath(); ctx.roundRect(m - e, m - e, w + e * 2, h + e * 2, h / 2 + e); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(m, m, w, h, h / 2); ctx.fill();
  // the glyph, drawn from its 24-unit grid like the other map symbols
  ctx.save();
  ctx.translate(m + (label ? 5 : (w - g) / 2), m + (h - g) / 2);
  ctx.scale(g / 24, g / 24);
  ctx.strokeStyle = fg; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const shapes = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`, 'image/svg+xml').documentElement.children;
  for (const el of Array.from(shapes)) {
    ctx.lineWidth = Number(el.getAttribute('stroke-width')) || 2.2;
    if (el.tagName === 'rect') {
      const n = (a: string) => Number(el.getAttribute(a)) || 0;
      ctx.beginPath(); ctx.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx')); ctx.stroke();
    } else if (el.tagName === 'path') ctx.stroke(new Path2D(el.getAttribute('d') || ''));
    else if (el.tagName === 'circle') { // solid, like a wheel
      const n = (a: string) => Number(el.getAttribute(a)) || 0;
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
  if (label) {
    ctx.fillStyle = fg;
    ctx.font = `800 14px ${SPRITE_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, m + 5 + g + 4, m + h / 2 + .5);
  }
  return spriteOut(c, ctx, ratio);
}
// A place on the map: a palette-coloured disc with a white rim and the group's glyph
function placeSprite(glyph: string, color: string, dark: boolean, ratio: number) {
  const path = MAP_LAYERS.GLYPHS[glyph];
  const col = MAP_LAYERS.COLORS[color as MapColorName];
  if (!path || !col) return null;
  const d = 26, m = 3, r = d / 2, cx = m + r;
  const [c, ctx] = spriteCanvas(d + m * 2, d + m * 2, ratio);
  ctx.shadowColor = 'rgba(8,10,14,.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.arc(cx, cx, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = dark && color === 'navy' ? '#4A6AA3' : col.fill; // navy lifted on the dark map, like --navy
  ctx.beginPath(); ctx.arc(cx, cx, r - 1.75, 0, Math.PI * 2); ctx.fill();
  const g = 15; // glyph size, from its 24-unit grid
  ctx.translate(cx - g / 2, cx - g / 2);
  ctx.scale(g / 24, g / 24);
  ctx.strokeStyle = col.ink;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(path));
  return spriteOut(c, ctx, ratio);
}
// The boarding point as a sign: ink plate with a yellow stripe, "Platform 7"; a round marker when it has no name
function signSprite(label: string, noun: string, dark: boolean, ratio: number) {
  const fs = 21, h = 38, m = 6;
  const bg = dark ? '#F2F3F5' : INK, ink = dark ? INK : '#FFFFFF', outline = dark ? '#0B0D10' : '#FFFFFF';
  const shadow = (ctx: CanvasRenderingContext2D) => { ctx.shadowColor = 'rgba(8,12,24,.4)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2; };
  if (!label) {
    const d = 32, r = d / 2;
    const [c, ctx] = spriteCanvas(d + m * 2, d + m * 2, ratio);
    shadow(ctx);
    ctx.fillStyle = outline;
    ctx.beginPath(); ctx.arc(m + r, m + r, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(m + r, m + r, r - 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = WALK;
    ctx.beginPath(); ctx.arc(m + r, m + r, r * .36, 0, Math.PI * 2); ctx.fill();
    return spriteOut(c, ctx, ratio);
  }
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `800 ${fs}px ${SPRITE_FONT}`;
  const tw = probe.measureText(label).width;
  probe.font = `600 11px ${SPRITE_FONT}`;
  const nw = noun ? probe.measureText(noun).width + 6 : 0;
  const w = Math.max(h, tw + nw + 18);
  const [c, ctx] = spriteCanvas(w + m * 2, h + m * 2, ratio);
  shadow(ctx);
  ctx.fillStyle = outline;
  ctx.beginPath(); ctx.roundRect(m - 1.5, m - 1.5, w + 3, h + 3, 8.5); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.beginPath(); ctx.roundRect(m, m, w, h, 7); ctx.clip();
  ctx.fillStyle = bg; ctx.fillRect(m, m, w, h);
  ctx.fillStyle = WALK; ctx.fillRect(m, m + h - 4.5, w, 4.5);
  ctx.restore();
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  const cy = m + (h - 4.5) / 2 + .5;
  let x = m + (w - tw - nw) / 2;
  if (noun) { ctx.font = `600 11px ${SPRITE_FONT}`; ctx.fillText(noun, x, cy + .5); x += nw; }
  ctx.font = `800 ${fs}px ${SPRITE_FONT}`;
  ctx.fillText(label, x, cy);
  return spriteOut(c, ctx, ratio);
}
// Arrowhead pointing east; MapLibre turns it along the walking route
function arrowSprite(ratio: number) {
  const [c, ctx] = spriteCanvas(9, 9, ratio);
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.moveTo(1.2, 1); ctx.lineTo(8, 4.5); ctx.lineTo(1.2, 8); ctx.lineTo(2.8, 4.5); ctx.closePath(); ctx.fill();
  return spriteOut(c, ctx, ratio);
}
// Where the journey starts: a ring
function fromSprite(ratio: number) {
  const d = 18;
  const [c, ctx] = spriteCanvas(d + 8, d + 8, ratio);
  ctx.shadowColor = 'rgba(8,10,14,.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.arc(4 + d / 2, 4 + d / 2, d / 2, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = INK; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(4 + d / 2, 4 + d / 2, d / 2 - 3.5, 0, Math.PI * 2); ctx.stroke();
  return spriteOut(c, ctx, ratio);
}
// Pill on the route where it changes level: ↓ −4
function levelSprite(up: boolean, label: string, dark: boolean, ratio: number) {
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `700 13px ${SPRITE_FONT}`;
  const tw = probe.measureText(label).width;
  const h = 24, w = tw + 32, m = 4;
  const [c, ctx] = spriteCanvas(w + m * 2, h + m * 2, ratio);
  ctx.shadowColor = 'rgba(8,10,14,.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = dark ? '#23272E' : '#FFFFFF';
  ctx.beginPath(); ctx.roundRect(m, m, w, h, h / 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  const fg = dark ? '#F2F3F5' : INK;
  ctx.strokeStyle = fg; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(m + .75, m + .75, w - 1.5, h - 1.5, (h - 1.5) / 2); ctx.stroke();
  const ax = m + 12, cy = m + h / 2, d = up ? -1 : 1;
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, cy - 5 * d); ctx.lineTo(ax, cy + 5 * d);
  ctx.moveTo(ax - 4, cy + d); ctx.lineTo(ax, cy + 5 * d); ctx.lineTo(ax + 4, cy + d);
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = `700 13px ${SPRITE_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, m + 22, cy + .5);
  return spriteOut(c, ctx, ratio);
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  map.on('styleimagemissing', (e) => {
    if (map.hasImage(e.id)) return;
    const s = makeSprite(e.id);
    if (s) map.addImage(e.id, s.data, { pixelRatio: s.ratio });
  });
}
