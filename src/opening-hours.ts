// OpenStreetMap's opening_hours, the common part of it: whether a place is open now, and until when.
//
//   openState('Mo-Fr 08:00-18:30; Sa 09:00-16:00; Su off', date) → { open: true, text: 'Open · Closes 18:30' }
//
// Understood: '24/7'; rules separated by ';' (a later rule replaces an earlier one for the days it names), each
// with days (Mo-Fr, Sa,Su, Mo-Su, also none = every day) and times (08:00-12:00,13:30-18:00; past midnight as
// 18:00-02:00 or 18:00-26:00) or 'off'/'closed'. Public holidays ('PH …'), school holidays, months, weeks, sunrise
// and the like are not: then null, and the card shows the hours as mapped without saying open or closed.
// weekLines() writes the week out ('Monday: 08:00–18:30') for the card, from the same rules.

/** Open or closed now, and the line the card and the list show ('Open · Closes 22:00', 'Closed · Opens Mon 08:00'). */
export interface OpenState { open: boolean; text: string }

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Per weekday (0 = Monday): the open intervals in minutes from that day's midnight (the end may pass 1440). */
type Week = [number, number][][];

function parseDays(s: string): number[] | null {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return null;
    const a = DAYS.indexOf(m[1]), b = m[2] ? DAYS.indexOf(m[2]) : a;
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return [...out];
}
function parseTimes(s: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of s.split(',')) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/.exec(part.trim());
    if (!m) return null;
    const a = +m[1] * 60 + +m[2];
    let b = +m[3] * 60 + +m[4];
    if (a > 24 * 60 || b > 48 * 60) return null;
    if (b <= a) b += 24 * 60; // 18:00-02:00: into the next day
    out.push([a, b]);
  }
  return out;
}
/** The week of a value, or null when it has more than this file understands. */
export function parseOpeningHours(value: string | null | undefined): Week | null {
  const v = (value || '').trim();
  if (!v) return null;
  if (v === '24/7') return Array.from({ length: 7 }, () => [[0, 24 * 60]]);
  const week: Week = Array.from({ length: 7 }, () => []);
  for (const raw of v.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.*)$/.exec(rule);
    if (!m) return null;
    const days = m[1] ? parseDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    const what = m[2].trim();
    if (!days) return null;
    if (/^(off|closed)$/i.test(what)) { for (const d of days) week[d] = []; continue; }
    const times = parseTimes(what);
    if (!times) return null;
    for (const d of days) week[d] = times;
  }
  return week;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Open or closed at `now` (the device's clock: the places are in Switzerland, as the traveller is), or null. */
export function openState(value: string | null | undefined, now = new Date()): OpenState | null {
  const week = parseOpeningHours(value);
  if (!week) return null;
  if (week.every((d) => d.length === 1 && d[0][0] === 0 && d[0][1] >= 24 * 60)) return { open: true, text: 'Open 24 hours' };
  const today = (now.getDay() + 6) % 7;
  const t = now.getHours() * 60 + now.getMinutes();
  // open now: today's intervals, or yesterday's that run past midnight
  const yesterday = (today + 6) % 7;
  const spans: [number, number][] = [...week[today], ...week[yesterday].map(([a, b]): [number, number] => [a - 1440, b - 1440])];
  const cur = spans.find(([a, b]) => t >= a && t < b);
  if (cur) {
    // open until midnight and from midnight the next day (Fr 18:00-24:00; Sa 00:00-03:00): it runs on
    let end = cur[1];
    for (let day = 1; day <= 7 && end > 0 && end === day * 1440; day++) {
      const next = week[(today + day) % 7].find(([a]) => a === 0);
      if (!next) break;
      end = day * 1440 + next[1];
    }
    if (end - t >= 7 * 1440) return { open: true, text: 'Open 24 hours' };
    return { open: true, text: `Open · Closes ${hhmm(end)}` };
  }
  for (let day = 0; day < 7; day++) {
    const d = (today + day) % 7;
    const next = week[d].map(([a]) => a).filter((a) => day > 0 || a > t).sort((a, b) => a - b)[0];
    if (next != null) return { open: false, text: `Closed · Opens ${day === 0 ? '' : day === 1 ? 'tomorrow ' : SHORT[d] + ' '}${hhmm(next)}` };
  }
  return { open: false, text: 'Closed' };
}

/** The week written out for the card ('Monday: 08:00–12:00, 13:30–18:00', 'Sunday: Closed'), or [] when not understood. */
export function weekLines(value: string | null | undefined): string[] {
  const week = parseOpeningHours(value);
  if (!week) return [];
  return week.map((spans, d) => `${DAY_NAMES[d]}: ${spans.length
    ? spans.map(([a, b]) => (a === 0 && b >= 1440 ? 'Open 24 hours' : `${hhmm(a)}–${hhmm(b)}`)).join(', ') : 'Closed'}`);
}
