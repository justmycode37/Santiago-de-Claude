// ---- Guidance: what a screen reader (and Read aloud) is told during a trip (src/a11y.ts, docs/screen-readers.md) ----
// After Start, each new step and each change is said once, as one sentence: where to walk, where you are,
// when to get off, a platform that changed. Never the minutes counting down. Tapping Start again says the
// current step once more. Everything said is also in the sheet, to be read at your own pace.
// Guidance is on while you are under way (after Start, until either end of the trip is changed or it is closed).

/** One thing to say: `key` changes only when what it is about does, so each is said once. */
interface GuideNote {
  key: string;
  text: string;
  /** Interrupts the screen reader. */
  urgent?: boolean;
  /** The step you are on (its index in journeySteps). */
  step?: number;
  /** Called once it has been said. */
  after?: () => void;
}

let guiding = false;
const guideSaid = new Set<string>();          // what has been said on this journey ("~…": may be said again once it is over)
const guideDelay = new Map<number, number[]>(); // ride (step number) → the delays said, in minutes and in order (0: on time again)
const guidePlat = new Map<number, string[]>(); // ride (step number) → the platforms it was said to have changed to, in order
const rideName = (st: JourneyRideStep) => lineName(st.s.journey);
// (a stop without a time in the timetable: nothing is said about when)
const leavesWords = (t: number | null, now: number) => {
  if (t == null) return 'leaves from here';
  const m = Math.round((t - now) / 60000);
  return m > 0 ? `leaves in ${A11Y.minutes(m)}` : m === 0 ? 'is leaving now' : `left ${A11Y.minutes(-m)} ago`;
};
// " tomorrow", " on Tue, 24 Nov"; nothing for today
const dayWords = (t: number) => { const day = dayLabel(t); return day === 'Today' ? '' : day === 'Tomorrow' ? ' tomorrow' : ` on ${day}`; };
// " 2 crossings with sound signals on the way." where they are mapped along the walk (Settings › Blind or low vision)
const soundsOnWay = (st: JourneyStep) => { const n = soundCrossings(walkPaths(st)); return n ? ` ${soundWords(n)} on the way.` : ''; };
// "sector B" / "sectors A to C", where the platform has them
const sectorWords = (q: Quay) => (q.sectors ? ` Stand in ${q.sectors.replace(/[^A-Za-z0-9]/g, '').length === 1 ? 'sector' : 'sectors'} ${q.sectors}.` : '');
const stepNo = (st: JourneyStep) => journeySteps.indexOf(st);
const destName = (): string => (journeyDest ? journeyDest.title : 'your destination');
// What comes after getting off a ride
function guideThen(i: number): string {
  const next = journeySteps[i + 1];
  if (!next) return '';
  if (next.type === 'change' && next.nextRide) return ` Then change to ${rideName(next.nextRide)} at ${boardName(next.nextRide)}.`;
  if (next.type === 'walk' && next.final) return ` Then walk to ${next.toName || destName()}.`;
  return '';
}
function guideAt(r: JourneyRideStep, now: number): GuideNote {
  const q = quayOf(r, 'dep'), where = q.label ? `${q.word} ${q.label}` : r.s.departure.station!.name;
  const access = stopAccess(r);
  return { key: `at|${stepNo(r)}`, step: stepNo(r), text: `You are at ${where}. ${rideName(r)} to ${r.s.journey.to} ${leavesWords(r.t0, now)}.${sectorWords(q)}${access.length ? ` Here: ${access.join(', ').toLowerCase()}.` : ''}` };
}
function guideLast(st: JourneyRideStep, lead: string): GuideNote {
  return { key: `last|${stepNo(st)}`, step: stepNo(st), urgent: true, text: `${lead} Get off there.${guideThen(stepNo(st))}` };
}
// Where you are on the trip → { key (changes only when the step does), text, urgent, step }, or null
function guidePosition(now: number): GuideNote | null {
  const t = track && gpsOn() ? track : null;
  if (t) {
    if (t.off) return { key: '~off', step: t.i, urgent: true, text: `You are off the route, about ${A11Y.metres(t.near)} away.` };
    if (t.missed) return { key: `missed|${stepNo(t.missed)}`, step: t.i, urgent: true, text: `${rideName(t.missed)} may have left without you. It left at ${fmtTime(t.missed.t0)}. Replan finds another way.` };
    if (t.arrived) return { key: 'arrived', step: t.i, text: `You have arrived at ${destName()}.` };
    const st = journeySteps[t.i], left = Math.max(0, tripLayout().lens[t.i] - t.kmIn) * 1000;
    if (st.type === 'arrive') return null;
    if (st.type === 'ride') {
      if (st.t0 != null && now < st.t0 && t.kmIn < 0.05) return guideAt(st, now);
      // The stops after the one you boarded at: those still to come (30 m ahead or more), and those not yet behind
      // you (a stop you are pulling into or standing at is still to be passed). Yours is "the next stop" only once
      // the one before it is behind you: said 20 m before that stop, "get off at the next stop" would be heard
      // as its doors open.
      const after = stopKms(st).slice(1), to = st.s.arrival.station!.name;
      const n = after.filter((k) => k > t.kmIn + 0.03).length, notPassed = after.filter((k) => k > t.kmIn - 0.03).length;
      const on = `You are on ${rideName(st)} towards ${st.s.journey.to}.`;
      if (notPassed > 1) return { key: `ride|${t.i}`, step: t.i, text: `${on} ${Math.max(n, 2)} stops to ${to}, arriving at ${fmtTime(st.t1)}.` };
      // Your stop is the next one. Close to it (in time or metres) that interrupts; on a long run to it, as on a
      // non-stop train, it is first said calmly, and again when you are nearly there.
      if ((st.t1 != null && st.t1 - now <= 180000) || left < 400) return guideLast(st, `Next stop: ${to}.`);
      return { key: `next|${t.i}`, step: t.i, text: `${guideSaid.has(`ride|${t.i}`) ? '' : on + ' '}The next stop is ${to}${st.t1 != null ? `, at ${fmtTime(st.t1)}` : ''}. Get off there.` };
    }
    const r = st.nextRide;
    const lvl = levelChange(st);
    if (st.final || !r) return { key: `walk|${t.i}`, step: t.i, text: `Walk ${A11Y.metres(left)} to ${st.toName || destName()}.${lvl ? ` ${lvl.text}.` : ''}${soundsOnWay(st)}` };
    if (left < 30) return guideAt(r, now);
    return { key: `walk|${t.i}`, step: t.i, text: `${st.type === 'change' ? 'Change' : 'Walk'}: ${A11Y.metres(left)} to ${boardName(r)}.${lvl ? ` ${lvl.text}.` : ''}${soundsOnWay(st)} ${rideName(r)} to ${r.s.journey.to} ${leavesWords(r.t0, now)}.` };
  }
  // without GPS: where the live timetable puts the trip, said as such
  const rides = journeySteps.filter((st): st is JourneyRideStep => st.type === 'ride');
  const ride = rides.find((st) => st.t0 != null && st.t1 != null && now >= st.t0 && now <= st.t1);
  if (ride) {
    const to = ride.s.arrival.station!.name, i = stepNo(ride), t1 = ride.t1!;
    if (t1 - now <= 120000) return guideLast(ride, `By the timetable, ${rideName(ride)} reaches ${to} in about ${A11Y.minutes(Math.max(1, Math.round((t1 - now) / 60000)))}.`);
    return { key: `ride|${i}`, step: i, text: `By the timetable you are now on ${rideName(ride)} towards ${ride.s.journey.to}. Get off at ${to} at ${fmtTime(t1)}.` };
  }
  const tp = timeProgress(now);
  if (tp && tp.ended) return { key: 'ended', step: journeySteps.length - 1, text: 'By the timetable, this journey has ended.' };
  const next = rides.find((st) => st.t0 != null && st.t0 > now);
  const cur = tp ? journeySteps[tp.i] : null;
  if (next) {
    const i = stepNo(next), q = quayOf(next, 'dep'), t0 = next.t0!;
    // the walk or change to it comes first: "leaves in 4 minutes" alone would leave out how to get there
    const walk = tp && cur && cur.nextRide === next && (cur.type === 'walk' || cur.type === 'change') && cur.t1 != null && now < cur.t1 ? cur : null;
    if (walk) {
      const d = walkDist(walk), lvl = levelChange(walk);
      return { key: `walk|${tp!.i}`, step: tp!.i, text: `${walk.type === 'change' ? 'Change' : 'Walk'} to ${boardName(next)} now${d ? `, ${A11Y.metres(d)}` : ''}.${lvl ? ` ${lvl.text}.` : ''}${soundsOnWay(walk)} ${rideName(next)} to ${next.s.journey.to} ${t0 - now <= 5 * 60000 ? leavesWords(t0, now) : `leaves at ${fmtTime(t0)}`}.${sectorWords(q)}` };
    }
    if (t0 - now <= 5 * 60000) {
      return { key: `soon|${i}`, step: i, text: `${rideName(next)} to ${next.s.journey.to} ${leavesWords(t0, now)} from ${boardName(next)}.${sectorWords(q)}` };
    }
    const first = journeySteps[0];
    if (!tp && first && first.type === 'walk' && first.nextRide === next && first.t0 != null && now < first.t0) {
      return { key: 'before', step: 0, text: `Leave at ${fmtTime(first.t0)}${dayWords(first.t0)} to walk to ${boardName(next)}.${soundsOnWay(first)} ${rideName(next)} to ${next.s.journey.to} leaves at ${fmtTime(t0)}.` };
    }
    return { key: `wait|${i}`, step: i, text: `${rideName(next)} to ${next.s.journey.to} leaves from ${boardName(next)} at ${fmtTime(t0)}${dayWords(t0)}.${sectorWords(q)}` };
  }
  if (tp && cur && cur.type === 'walk' && cur.final && cur.t1 != null && now < cur.t1) {
    const d = walkDist(cur);
    return { key: `walk|${tp.i}`, step: tp.i, text: `Walk to ${cur.toName || destName()}${d ? `, ${A11Y.metres(d)}` : ''}.${soundsOnWay(cur)}` };
  }
  const only = journeySteps[0];
  if (!tp && only && only.type === 'walk' && only.final) {
    const d = walkDist(only);
    return { key: 'before', step: 0, text: `Walk to ${only.toName || destName()}${d ? `, ${A11Y.metres(d)}` : ''}, about ${durWords((only.min || 0) * 60)}.${soundsOnWay(only)}` };
  }
  return null;
}
// Things that changed on the rides still ahead: cancelled, another platform, a delay, a change that won't work
function guideAlerts(now: number, from: number): GuideNote[] {
  const out: GuideNote[] = [];
  const upcoming = journeySteps.find((st, i) => st.type === 'ride' && i >= from && st.t0 != null && now < st.t0);
  journeySteps.forEach((st, i) => {
    if (st.type !== 'ride' || i < from || (st.t1 != null && now > st.t1)) return;
    const name = rideName(st), q = quayOf(st, 'dep'), ahead = st.t0 != null && now < st.t0;
    const trip = engineFresh(st.s, true) && st.s._k ? st.s._k.trip : null;
    if (trip && trip.cancelled) { out.push({ key: `cancel|${i}`, urgent: true, text: `${name} is cancelled. Replan finds another way.` }); return; }
    // Another platform than planned, and every change after that: to a third one, or back to the planned one
    // (when it is back, `planned` is empty again, so what was said last is what tells)
    const saidPlats = guidePlat.get(i) || [], saidPlat = saidPlats[saidPlats.length - 1];
    const planned = q.planned && q.planned !== q.label ? q.planned : ''; // (new sectors on the same platform are no change of platform)
    if (ahead && q.label && q.label !== saidPlat && (planned || saidPlat)) {
      out.push({ key: `plat|${i}|${saidPlats.length}`, urgent: true, after: () => guidePlat.set(i, [...saidPlats, q.label]),
        text: planned ? `${q.word} change: ${name} now leaves from ${q.word.toLowerCase()} ${q.label}, not ${planned}.`
          : `${q.word} change: ${name} leaves from ${q.word.toLowerCase()} ${q.label} after all, not ${saidPlat}.` });
    }
    if (st !== upcoming) return;
    // A delay of 3 minutes or more, each time it has changed by 3 or more, and when it is gone again
    const late = lateMin(st.s.departure, 'departure'), saidLates = guideDelay.get(i) || [], said = saidLates[saidLates.length - 1] || 0;
    const key = `delay|${i}|${saidLates.length}`, after = (m: number) => () => { guideDelay.set(i, [...saidLates, m]); };
    if (late >= 3 && Math.abs(late - said) >= 3) {
      out.push({ key, after: after(late), text: `${name} is ${A11Y.minutes(late)} late. It now leaves at ${fmtTime(st.t0)}.` });
    } else if (said >= 3 && late < 1) {
      out.push({ key, after: after(0), text: `${name} is on time again. It leaves at ${fmtTime(st.t0)}.` });
    }
  });
  const broken = brokenChange(now, from);
  if (broken && broken.type === 'change' && broken.nextRide) {
    out.push({ key: `broken|${stepNo(broken)}`, urgent: true,
      text: `The change at ${broken.next.departure.station!.name} will not work: ${rideName(broken.nextRide)} leaves at ${fmtTime(liveMs(broken.next.departure, 'departure'))}. Replan finds another way.` });
  }
  return out;
}
// Little time for the walk to the next ride, at your walking speed (with GPS only): said once per walk
function guideHurry(now: number): GuideNote | null {
  const t = track && gpsOn() && !track.off && !track.arrived ? track : null, st = t && journeySteps[t.i];
  if (!t || !st || st.type === 'ride' || st.type === 'arrive' || st.final || !st.nextRide) return null;
  const left = Math.max(0, tripLayout().lens[t.i] - t.kmIn) * 1000, r = st.nextRide;
  const hr = left >= 30 ? hurry(left, r, now) : null;
  if (!hr || hr.level === 'ok') return null;
  // the header's "1 min to spare" is always there to read; said out loud only when it is really close
  if (r.t0 == null) return null;
  const spare = (r.t0 - now) / 1000 - left / ((SETTINGS.prefs().walkKmh || 4.7) / 3.6);
  if (spare >= 60) return null;
  return { key: `hurry|${t.i}`, urgent: true, text: hr.level === 'late'
    ? `At your walking speed you may miss ${rideName(r)}: ${A11Y.metres(left)} to go and it ${leavesWords(r.t0, now)}.`
    : `Less than a minute to spare: ${A11Y.metres(left)} to ${boardName(r)} and ${rideName(r)} ${leavesWords(r.t0, now)}.` };
}
// A new place on the trip is only said once it has held for a moment: one stray GPS fix can put you on the
// next ride for an instant. atOnce: it was asked for (Start, a new journey), so it is said without waiting.
let guideHeld = { key: '', since: 0 };
function guideNews(now: number, atOnce?: boolean): { pos: GuideNote | null; news: GuideNote[] } {
  const pos = guidePosition(now), from = pos && pos.step != null ? pos.step : 0;
  // an "off the route" that is over may be said again the next time it happens
  for (const k of [...guideSaid]) if (k[0] === '~' && (!pos || pos.key !== k)) guideSaid.delete(k);
  let settled = true;
  if (pos && !atOnce && !guideSaid.has(pos.key)) {
    if (guideHeld.key !== pos.key) guideHeld = { key: pos.key, since: now };
    settled = now - guideHeld.since >= (pos.key[0] === '~' ? 10000 : 3000); // "off the route" interrupts: it has to be sure
  } else guideHeld = { key: '', since: 0 }; // back on something already said (or nowhere): the wait starts afresh next time
  const all = [...guideAlerts(now, from), settled ? pos : null, settled ? guideHurry(now) : null];
  return { pos, news: all.filter((e): e is GuideNote => !!e && !guideSaid.has(e.key)) };
}
function guideSay(news: GuideNote[], lead = '') {
  news.forEach((e) => { guideSaid.add(e.key); if (e.after) e.after(); });
  const text = [lead, ...news.map((e) => e.text)].filter(Boolean).join(' ');
  if (text) A11Y.say(text, { urgent: news.some((e) => e.urgent) });
}
function guideTick() {
  if (!guiding || journeyList || !journeyConn || !journeySteps.length) return;
  const { news } = guideNews(Date.now());
  if (news.length) guideSay(news);
}
// Start: guidance on. Start again: the current step once more.
function startGuidance() {
  if (!journeyConn || !journeySteps.length) return;
  const again = guiding, now = Date.now();
  guiding = true;
  if (lowVision()) A11Y.keepAwake(true); // a browser stops a page whose screen is off
  const { pos, news } = guideNews(now, true);
  const all = pos && !news.includes(pos) ? [...news, pos] : news; // the current step is said again when asked for
  guideSay(all, again ? '' : 'Guidance is on.');
  syncStartLabel(); // the Start button now says what it does next
}
// No longer under way (either end of the trip is being changed, or the journey was closed)
function stopGuidance() {
  if (!guiding) return;
  guiding = false;
  guideSaid.clear();
  guideDelay.clear();
  guidePlat.clear();
  A11Y.keepAwake(false);
  A11Y.hush();
  syncStartLabel();
}
// A journey in a sentence: "Journey to Zytglogge: 14:50 to 16:01, 1 hour 11 minutes, direct with IC 8."
function journeySummary(lead = `Journey to ${destName()}: `): string {
  const rides = journeySteps.filter((st): st is JourneyRideStep => st.type === 'ride'), end = journeyEnd();
  const start = new Date(journeyConn!.from.departure!).getTime();
  const changes = rides.length - 1;
  const how = !rides.length ? 'on foot' : `${changes <= 0 ? 'direct' : changes === 1 ? '1 change' : `${changes} changes`} with ${rides.map(rideName).join(', then ')}`;
  return `${lead}${fmtTime(start)} to ${fmtTime(end)}${dayWords(start)}, ${durWords((end - start) / 1000)}, ${how}.`;
}
// A journey is on show (found, found again, or picked from the list): the journey in a sentence, then what to do
// first. While guidance is on: where you are now, and whatever has changed.
function announceJourney() {
  const { pos, news } = guideNews(Date.now(), true);
  guideSay(guiding ? news : [], [journeySummary(), !guiding && pos ? pos.text : ''].filter(Boolean).join(' '));
}
// Several journeys to choose from: how many, and the one drawn on the map
function announceOptions() {
  A11Y.say(`${optionCount()} journeys to ${destName()}. ${journeySummary('On the map: ')} Choose one from the list.`);
}
