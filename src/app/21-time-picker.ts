// ---- Time picker: tap the departure or arrival time ----
const tSheet = document.getElementById('tSheet');
const tDim = document.getElementById('tDim');
const tDate = document.getElementById('tDate');
const tTime = document.getElementById('tTime');
let tMode = 'dep';
const pad2 = (n) => String(n).padStart(2, '0');
const dateValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeValue = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function setTMode(m) {
  tMode = m;
  document.querySelectorAll('#tSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
}
function openTimeSheet(mode) {
  if (!journeyDest) return;
  setTMode(mode);
  const ref = journeyConn ? new Date(mode === 'arr' ? journeyConn.to.arrival : journeyConn.from.departure) : new Date();
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
document.getElementById('jDepBtn').addEventListener('click', () => openTimeSheet('dep'));
document.getElementById('jArrBtn').addEventListener('click', () => openTimeSheet('arr'));
document.querySelectorAll('#tSeg button').forEach((b) => b.addEventListener('click', () => setTMode(b.dataset.mode)));
tDim.addEventListener('click', closeTimeSheet);
document.getElementById('tNow').addEventListener('click', () => {
  journeyQuery = { mode: 'dep', date: '', time: '' };
  closeTimeSheet();
  startJourney(journeyDest, true);
});
document.getElementById('tDone').addEventListener('click', () => {
  journeyQuery = { mode: tMode, date: tDate.value, time: tTime.value };
  closeTimeSheet();
  startJourney(journeyDest, true);
});
