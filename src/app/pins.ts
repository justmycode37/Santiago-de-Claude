// ---------- Pins: put either end of the trip on the map by hand ----------
// Three ways, all ending in dropPin(): drag the pin out of the card onto the map · tap the pin, then tap the
// map · long-press (or right-click) the map and pick "From here" / "To here". A pin already on the map can be
// dragged to move it.
import { map } from './map.ts';
import { setMenu } from './menu.ts';
import { showToast } from '../toast.ts';
import { inSwitzerland } from './location.ts';
import { FIELDS, PIN_ART, destMarker, form, inputs, startMarker, toks } from './search.ts';
import { pins } from './search-pins.ts';
import { blurSearch, closeSearch, pointOf, setField, setPlanOpen, setStart, showDestinationJourney } from './trip-ends.ts';
import { platformPopup } from './platforms.ts';
import { journeyEl } from './journey-map.ts';
import { setDetent, sheetDetent } from './sheet.ts';
import { renderSheet } from './sheet-content.ts';
import { journey, searchState } from './state.ts';
import { PlaceSearch } from '../places.ts';
import type { SearchResult, TripField } from './search.ts';
const PIN_WORD = { from: 'start', to: 'destination' };
const pinHint = document.getElementById('pinHint')!;
let armedPin: TripField | null = null; // the pin that the next tap on the map places
export function armPin(f: TripField | null) {
  armedPin = f;
  for (const k of FIELDS) toks[k].classList.toggle('armed', k === f);
  document.body.classList.toggle('pin-armed', !!f);
  pinHint.hidden = !f;
  if (!f) return;
  document.getElementById('pinHintText')!.textContent = `Tap the map to set the ${PIN_WORD[f]}`;
  closeSearch();
  setMenu(false);
  pinMenu.remove();
  if (f === 'from') setPlanOpen(true);
  if (document.body.classList.contains('journey-mode') && sheetDetent !== 'low') setDetent('low'); // as much map to tap on as there is
}

// → false when the pin cannot go there
function dropPin(f: TripField, lngLat: LngLat) {
  if (!inSwitzerland(lngLat)) { showToast('Pins can only be placed in Switzerland.'); return false; }
  const r: SearchResult = { title: 'Dropped pin', subtitle: '', kind: 'address', origin: 'pin', lngLat };
  if (f === 'from') setStart(r);
  else showDestinationJourney(r, true);
  namePin(r);
  return true;
}
// "Dropped pin" → "Kramgasse 12", once the address at that point is known
async function namePin(r: SearchResult) {
  if (!PlaceSearch || !PlaceSearch.reverse) return;
  const hit = await PlaceSearch.reverse(r.lngLat).catch(() => null);
  const f = searchState.tripStart === r ? 'from' : journey.dest === r ? 'to' : null; // it may have been swapped, or replaced, meanwhile
  if (!hit || !f) return;
  r.title = hit.title;
  if (document.activeElement !== inputs[f] && !(pins && pins.field === f)) setField(f, r.title);
  if (f === 'from') journey.from = r.title;
  else journey.steps.forEach((st) => { if (st.final) st.toName = r.title; if (st.type === 'arrive') st.destTitle = r.title; });
  if (document.body.classList.contains('journey-mode')) renderSheet();
}

// Dragging a pin out of the card: it floats above the finger (so its tip can be seen), and lands where the tip is
const ghost = document.createElement('div');
ghost.className = 'pin-ghost';
/** A press on a pin of the card: which pointer, where it went down and where it is now, how far above it the pin floats. */
interface PinDrag {
  id: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  lift: number;
  /** The pin has left its place in the card. */
  on: boolean;
  /** The frame request that slides the map along while the pin is near an edge. */
  raf?: number;
}
// Where the pin would land → [x, y], or null over the card (= put it back) and under the journey sheet
function pinDropPoint(d: PinDrag): [x: number, y: number] | null {
  const x = d.x, y = d.y - d.lift;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
  const card = form.getBoundingClientRect();
  if (x >= card.left - 6 && x <= card.right + 6 && y <= card.bottom + 6) return null;
  if (document.body.classList.contains('journey-mode')) {
    const sheet = journeyEl.getBoundingClientRect();
    if (x >= sheet.left && x <= sheet.right && y >= sheet.top) return null;
  }
  return [x, y];
}
function movePinGhost(d: PinDrag) {
  ghost.style.transform = `translate3d(${d.x}px,${d.y - d.lift}px,0)`;
  ghost.classList.toggle('off', !pinDropPoint(d));
}
// Near an edge of the map the map slides along, so the pin can go somewhere that was off screen
function panAtEdge(d: PinDrag) {
  if (!pinDropPoint(d)) return;
  const m = 56, max = 9, w = window.innerWidth;
  const sheet = document.body.classList.contains('journey-mode') ? journeyEl.getBoundingClientRect() : null;
  const bottom = sheet && d.x >= sheet.left && d.x <= sheet.right ? Math.min(window.innerHeight, sheet.top) : window.innerHeight;
  const tipY = d.y - d.lift;
  const over = (v: number) => Math.max(0, Math.min(1, v / m)) * max;
  const dx = over(d.x - (w - m)) - over(m - d.x);
  const dy = over(d.y - (bottom - m)) - over(m - tipY);
  if (dx || dy) map.panBy([dx, dy], { duration: 0 });
}
function beginPinDrag(f: TripField, d: PinDrag) {
  d.on = true;
  armPin(null);
  closeSearch();
  setMenu(false);
  pinMenu.remove();
  if (f === 'from') setPlanOpen(true);
  document.body.classList.add('pin-dragging');
  toks[f].classList.add('out');
  ghost.innerHTML = PIN_ART(f) + '<i></i><b></b>';
  ghost.lastChild!.textContent = f === 'from' ? 'Start here' : 'Go here';
  document.body.appendChild(ghost);
  if (document.body.classList.contains('journey-mode') && sheetDetent !== 'low') setDetent('low'); // as much map as there is
  const loop = () => { if (!d.on) return; panAtEdge(d); d.raf = requestAnimationFrame(loop); };
  d.raf = requestAnimationFrame(loop);
}
function endPinDrag(f: TripField, d: PinDrag, cancelled: boolean) {
  d.on = false;
  cancelAnimationFrame(d.raf!);
  const p = cancelled ? null : pinDropPoint(d);
  ghost.remove();
  document.body.classList.remove('pin-dragging');
  toks[f].classList.remove('out');
  if (p) dropPin(f, map.unproject(p).toArray());
}

// Long press / right click on the map: "From here" · "To here"
export const pinMenu = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'pf-pop pin-menu', maxWidth: 'none', offset: 10 });
let pinMenuAt = 0;     // when it last opened (Android sends both a long press and a context menu)
let pinMenuQuiet = 0;  // until then, a click on the map is the end of the long press, not a tap to close it
function openPinMenu(lngLat: LngLat) {
  if (Date.now() - pinMenuAt < 600 || document.body.classList.contains('pin-dragging') || !inSwitzerland(lngLat)) return;
  pinMenuAt = Date.now();
  pinMenuQuiet = pinMenuAt + 700;
  armPin(null);
  blurSearch();
  platformPopup.remove();
  const body = document.createElement('div');
  body.className = 'pin-menu-body';
  for (const [f, label] of [['from', 'From here'], ['to', 'To here']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = PIN_ART(f);
    b.append(label);
    b.addEventListener('click', () => { pinMenu.remove(); dropPin(f, lngLat); });
    body.append(b);
  }
  pinMenu.setLngLat(lngLat).setDOMContent(body).addTo(map);
}
// A tap on the map with a pin armed, or with the menu open → true: the tap has been used
export function pinTap(lngLat: LngLat) {
  if (armedPin) {
    const f = armedPin;
    armPin(null);
    dropPin(f, lngLat);
    return true;
  }
  if (!pinMenu.isOpen()) return false;
  if (Date.now() > pinMenuQuiet) pinMenu.remove();
  return true;
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  document.getElementById('pinHintCancel')!.addEventListener('click', () => armPin(null));
  for (const f of FIELDS) {
    const tok = toks[f];
    let drag: PinDrag | null = null;      // { id, x0, y0, x, y, lift, on, raf }: a press on the pin; on = it has left its place
    let dragged = false;  // the click that follows a drag is not a tap
    tok.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || drag) return;
      dragged = false;
      // a finger hides what is under it, a mouse pointer does not
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, lift: e.pointerType === 'mouse' ? 0 : 52, on: false };
      try { tok.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is already gone */ }
    });
    tok.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (!drag.on) {
        if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 8) return;
        beginPinDrag(f, drag);
      }
      movePinGhost(drag);
    });
    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.on) return;
      dragged = true;
      endPinDrag(f, d, cancelled);
    };
    tok.addEventListener('pointerup', (e) => finish(e, false));
    tok.addEventListener('pointercancel', (e) => finish(e, true));
    tok.addEventListener('click', () => {
      if (dragged) { dragged = false; return; }
      armPin(armedPin === f ? null : f);
    });
  }
  map.on('contextmenu', (e) => { e.preventDefault(); openPinMenu(e.lngLat.toArray()); });
  {
    let timer = 0, at: maplibregl.Point | null = null;
    const cancel = () => { clearTimeout(timer); timer = 0; };
    map.on('touchstart', (e) => {
      cancel();
      const oe = e.originalEvent;
      if (oe.touches.length !== 1 || oe.target !== map.getCanvas()) return; // not a pinch, not a marker
      at = e.point;
      const lngLat = e.lngLat.toArray();
      timer = setTimeout(() => { timer = 0; openPinMenu(lngLat); }, 550);
    });
    map.on('touchmove', (e) => { if (timer && (e.originalEvent.touches.length !== 1 || e.point.dist(at!) > 10)) cancel(); });
    map.on('touchend', () => { cancel(); if (pinMenu.isOpen()) pinMenuQuiet = Date.now() + 400; });
    map.on('touchcancel', cancel);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    armPin(null);
    pinMenu.remove();
  });
  // A pin on the map dragged somewhere else moves that end of the trip (and stays where it was if it cannot go there)
  for (const [f, marker] of [['from', startMarker], ['to', destMarker]] as const) {
    marker.on('dragstart', () => { pinMenu.remove(); armPin(null); });
    marker.on('dragend', () => {
      const was = pointOf(f);
      if (!dropPin(f, marker.getLngLat().toArray()) && was) marker.setLngLat(was.lngLat);
    });
  }
}
