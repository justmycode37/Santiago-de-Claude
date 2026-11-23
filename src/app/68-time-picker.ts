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
document.getElementById('whenChip')!.addEventListener('click', () => openTimeSheet(journeyQuery.mode));
function setTMode(m: TimeMode) {
  tMode = m;
  document.querySelectorAll<HTMLButtonElement>('#tSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
}
function openTimeSheet(mode: TimeMode) {
  if (!journeyDest) return;
  setTMode(mode);
  const ref = journeyConn ? new Date(mode === 'arr' ? journeyConn.t1 : journeyConn.t0) : new Date();
  tDate.value = journeyQuery.date || dateValue(ref);
  tTime.value = journeyQuery.time || timeValue(ref);
  if (journeyQuery.mode !== mode && journeyConn) { tDate.value = dateValue(ref); tTime.value = timeValue(ref); }
  tSheet.classList.add('open');
  tDim.classList.add('open');
  tSheet.setAttribute('aria-hidden', 'false');
}
function closeTimeSheet() {
  tSheet.classList.remove('open');
  tDim.classList.remove('open');
  tSheet.setAttribute('aria-hidden', 'true');
}
document.getElementById('jDepBtn')!.addEventListener('click', () => openTimeSheet('dep'));
document.getElementById('jArrBtn')!.addEventListener('click', () => openTimeSheet('arr'));
document.querySelectorAll<HTMLButtonElement>('#tSeg button').forEach((b) => b.addEventListener('click', () => setTMode(b.dataset.mode as TimeMode)));
tDim.addEventListener('click', closeTimeSheet);
document.getElementById('tNow')!.addEventListener('click', () => {
  journeyQuery = { mode: 'dep', date: '', time: '' };
  closeTimeSheet();
  startJourney(journeyDest!, true);
});
document.getElementById('tDone')!.addEventListener('click', () => {
  journeyQuery = { mode: tMode, date: tDate.value, time: tTime.value };
  closeTimeSheet();
  startJourney(journeyDest!, true);
});
