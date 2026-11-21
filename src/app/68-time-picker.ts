// ---- Time picker: tap the departure or arrival time ----
const tSheet = document.getElementById('tSheet')!;
const tDim = document.getElementById('tDim')!;
const tDate = document.getElementById('tDate') as HTMLInputElement;
const tTime = document.getElementById('tTime') as HTMLInputElement;
let tMode: TimeMode = 'dep';
const pad2 = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeValue = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// The chip in the card: "Leave now", "Leave 14:30", "Arrive by 9:00 Tomorrow"
function updateWhenChip() {
  const { mode, date, time } = journeyQuery;
  const day = date && date !== dateValue(new Date()) ? ' ' + dayLabel(date + 'T12:00') : '';
  document.getElementById('whenText')!.textContent = !date && !time ? 'Leave now'
    : `${mode === 'arr' ? 'Arrive by' : 'Leave'} ${time || ''}${day}`.replace(/\s+/g, ' ');
  document.getElementById('whenChip')!.hidden = !journeyDest;
}
document.getElementById('whenChip')!.addEventListener('click', (e) => openTimeSheet(journeyQuery.mode, e.currentTarget as HTMLElement));
function setTMode(m: TimeMode) {
  tMode = m;
  document.querySelectorAll<HTMLButtonElement>('#tSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === m);
    b.setAttribute('aria-pressed', String(b.dataset.mode === m)); // which of the two is chosen, for screen readers
  });
}
function openTimeSheet(mode: TimeMode, opener?: HTMLElement) {
  if (!journeyDest) return;
  setTMode(mode);
  const ref = journeyConn ? new Date(mode === 'arr' ? journeyConn.to.arrival! : journeyConn.from.departure!) : new Date();
  tDate.value = journeyQuery.date || dateValue(ref);
  tTime.value = journeyQuery.time || timeValue(ref);
  if (journeyQuery.mode !== mode && journeyConn) { tDate.value = dateValue(ref); tTime.value = timeValue(ref); }
  tSheet.classList.add('open');
  tDim.classList.add('open');
  tSheet.setAttribute('aria-hidden', 'false');
  // a dialog: the page behind is out of reach, focus starts on the choice you came for and returns to its button
  A11Y.openDialog(tSheet, { focus: document.querySelector<HTMLElement>(`#tSeg button[data-mode="${mode}"]`), returnTo: opener, keep: [tDim] });
}
function closeTimeSheet(restore = true) {
  if (!tSheet.classList.contains('open')) return;
  tSheet.classList.remove('open');
  tDim.classList.remove('open');
  tSheet.setAttribute('aria-hidden', 'true');
  A11Y.closeDialog(tSheet, { restore, fallback: journeyEl });
  tSheet.inert = true;
}
document.getElementById('tClose')!.addEventListener('click', () => closeTimeSheet());
tSheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTimeSheet(); });
document.getElementById('jDepBtn')!.addEventListener('click', (e) => openTimeSheet('dep', e.currentTarget as HTMLElement));
document.getElementById('jArrBtn')!.addEventListener('click', (e) => openTimeSheet('arr', e.currentTarget as HTMLElement));
document.querySelectorAll<HTMLButtonElement>('#tSeg button').forEach((b) => b.addEventListener('click', () => setTMode(b.dataset.mode as TimeMode)));
tDim.addEventListener('click', () => closeTimeSheet());
document.getElementById('tNow')!.addEventListener('click', () => {
  journeyQuery = { mode: 'dep', date: '', time: '' };
  closeTimeSheet(false); // the journey is searched again and takes the focus
  startJourney(journeyDest!, true);
});
document.getElementById('tDone')!.addEventListener('click', () => {
  journeyQuery = { mode: tMode, date: tDate.value, time: tTime.value };
  closeTimeSheet(false);
  startJourney(journeyDest!, true);
});
