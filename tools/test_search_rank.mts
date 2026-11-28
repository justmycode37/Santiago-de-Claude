// The search's pull towards what is near you (src/app/search-rank.ts): small, never more than one place, not for an
// exact name, not for a list that is nearest first already. Offline; exit code 1 on any failure.
//
//   node tools/test_search_rank.mts
import { NEAR_PULL, nearPull, nudgeNearYou } from '../src/app/search-rank.ts';

let passed = 0, failed = 0;
const check = (ok: unknown, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const BERN: LngLat = [7.4391, 46.9488], ZURICH: LngLat = [8.5402, 47.3782], GENEVA: LngLat = [6.1424, 46.2102];
const near = (km: number): LngLat => [BERN[0], BERN[1] + km / 111.2];
const r = (title: string, lngLat: LngLat) => ({ title, lngLat });
const order = (l: { title: string }[]) => l.map((x) => x.title).join(', ');

console.log('the pull');
check(nearPull(0) === 0, 'nothing for here');
check(nearPull(1) < 0.25, `a km: ${nearPull(1).toFixed(3)} of a place`);
check(nearPull(10) < 0.75 && nearPull(10) > nearPull(1), `10 km: ${nearPull(10).toFixed(3)}`);
check(nearPull(500) === NEAR_PULL && NEAR_PULL > 1 && NEAR_PULL < 2, 'far: the whole pull, between one and two places');
check(nearPull(25) < 1, `within 25 km nothing is passed: ${nearPull(25).toFixed(3)}`);

console.log('the order');
const list = [r('Coop Zürich', ZURICH), r('Coop Bern', near(0.5)), r('Coop Genève', GENEVA), r('Coop Wankdorf', near(1))];
check(order(nudgeNearYou('coop', list, false, null)) === order(list), 'no position: as it was');
check(order(nudgeNearYou('coop', list, true, BERN)) === order(list), 'a list nearest first already: as it was');
const got = nudgeNearYou('coop', list, false, BERN);
check(order(got) === 'Coop Bern, Coop Zürich, Coop Wankdorf, Coop Genève', `from Bern: ${order(got)}`);
check(got.every((x, i) => Math.abs(list.indexOf(x) - i) <= 1), 'no result moves more than one place');
const exact = [r('Zürich HB', ZURICH), r('Zürich HB Sihlquai', near(0.2))];
check(order(nudgeNearYou('zürich hb', exact, false, BERN)) === 'Zürich HB, Zürich HB Sihlquai', 'an exact name keeps its place');
const far3 = [r('A', GENEVA), r('B', ZURICH), r('C', near(1))];
check(order(nudgeNearYou('x', far3, false, BERN)) === 'A, C, B', `two far ones and a near one: ${order(nudgeNearYou('x', far3, false, BERN))}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
