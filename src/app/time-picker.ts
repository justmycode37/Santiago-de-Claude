// ---- Time picker: tap the departure or arrival time ----
import { dayLabel } from './journey-steps.ts';
import { startJourney } from './pill.ts';
import { journey } from './state.ts';

/** When the trip should be: leave at ('dep') or arrive by ('arr') a date and time; both empty = now. */
export type TimeMode = 'dep' | 'arr';
export interface JourneyQuery { mode: TimeMode; date: string; time: string }

const tSheet = document.getElementById('tSheet')!;
const tDim = document.getElementById('tDim')!;
const tDate = document.getElementById('tDate') as HTMLInputElement;
const tTime = document.getElementById('tTime') as HTMLInputElement;
let tMode: TimeMode = 'dep';
const pad2 = (n: number) => String(n).padStart(2, '0');
export const dateValue = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeValue = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// The chip in the card: "Leave now", "Leave 14:30", "Arrive by 9:00 Tomorrow"
export function updateWhenChip() {
  const { mode, date, time } = journey.query;
  const day = date && date !== dateValue(new Date()) ? ' ' + dayLabel(date + 'T12:00') : '';
  document.getElementById('whenText')!.textContent = !date && !time ? 'Leave now'
    : `${mode === 'arr' ? 'Arrive by' : 'Leave'} ${time || ''}${day}`.replace(/\s+/g, ' ');
  document.getElementById('whenChip')!.hidden = !journey.dest;
}
function setTMode(m: TimeMode) {
  tMode = m;
  document.querySelectorAll<HTMLButtonElement>('#tSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
}
function openTimeSheet(mode: TimeMode) {
  if (!journey.dest) return;
  setTMode(mode);
  const ref = journey.conn ? new Date(mode === 'arr' ? journey.conn.t1 : journey.conn.t0) : new Date();
  tDate.value = journey.query.date || dateValue(ref);
  tTime.value = journey.query.time || timeValue(ref);
  if (journey.query.mode !== mode && journey.conn) { tDate.value = dateValue(ref); tTime.value = timeValue(ref); }
  tSheet.classList.add('open');
  tDim.classList.add('open');
  tSheet.setAttribute('aria-hidden', 'false');
}
export function closeTimeSheet() {
  tSheet.classList.remove('open');
  tDim.classList.remove('open');
  tSheet.setAttribute('aria-hidden', 'true');
}

// The mode the time sheet was last used with, remembered on this device: the chip opens on it while the trip leaves
// now. Only the choice, never a date or time, which would be out of date. (Its own key, not the settings': writing
// those would save this tab's copy of all of them. "Reset all settings" removes it too.)
const MODE_KEY = 'timeMode';
function lastMode(): TimeMode { try { return localStorage.getItem(MODE_KEY) === 'arr' ? 'arr' : 'dep'; } catch (e) { return 'dep'; } }
function rememberMode(mode: TimeMode) {
  try { if (mode === 'arr') localStorage.setItem(MODE_KEY, 'arr'); else localStorage.removeItem(MODE_KEY); } catch (e) { /* this visit only */ }
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  document.getElementById('whenChip')!.addEventListener('click', () => {
    const { mode, date, time } = journey.query;
    openTimeSheet(date || time ? mode : lastMode());
  });
  document.getElementById('jDepBtn')!.addEventListener('click', () => openTimeSheet('dep'));
  document.getElementById('jArrBtn')!.addEventListener('click', () => openTimeSheet('arr'));
  document.querySelectorAll<HTMLButtonElement>('#tSeg button').forEach((b) => b.addEventListener('click', () => setTMode(b.dataset.mode as TimeMode)));
  tDim.addEventListener('click', closeTimeSheet);
  document.getElementById('tNow')!.addEventListener('click', () => {
    journey.query = { mode: 'dep', date: '', time: '' };
    rememberMode('dep');
    closeTimeSheet();
    startJourney(journey.dest!, true);
  });
  document.getElementById('tDone')!.addEventListener('click', () => {
    journey.query = { mode: tMode, date: tDate.value, time: tTime.value };
    rememberMode(tMode);
    closeTimeSheet();
    startJourney(journey.dest!, true);
  });
}
