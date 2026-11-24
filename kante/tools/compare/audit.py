#!/usr/bin/env python3
"""Audit one running engine: invariants its answers must hold, on a fresh national sample.

    audit.py --engine http://127.0.0.1:8092 --data B-data-dir --bin path/to/compare --seed 1 \
             [--points 5000] [--trips 1000] [--out audit/] [--threads 32]

Draws the sample with `compare sample <data> <points> <seed>` (crates/link/src/bin/compare.rs), asks the engine, and
counts the answers that break each invariant:

  1. a walk leg (access, egress, transfer, walking only, /api/walk) with a guessed end (approxStart / approxEnd)
     that says it is step-free;
  2. step-free and wheelchair plans: a journey's walk leg with a guessed end and no alert for it (kind "other",
     "step-free" in its text, `leg` its index; the walking-only journey's own alerts for it);
  3. a walk leg or /api/walk answer whose straight lines onto the network (outside `network`) run through a building
     (`compare through`, the data dir's outlines) where no guessed end is marked, or that is step-free with one;
  4. a journey's legs out of order or overlapping (a ride by its calls' times and delays), a ride boarded before the
     walk to it ends, a journey's dep / arr not its first leg's dep and last leg's arr (plan.rs `journey()`), an
     arrive-by journey arriving after the deadline;
  5. /api/reach: a stop over the limit, or a stop reached in 5 minutes and not 10, or in 10 and not 20;
  6. an error or non-200 answer, a timeout, or an answer the checks cannot read.

Plans: each trip in all three profiles, departing at its hour (from compare.DAY0) and arriving by that hour + 3 h,
and for each answer its `earlier` and `later` page. Walks: each walk in all three profiles. Reach: each point in all
three profiles at 5, 10 and 20 minutes. Prints one line per invariant with its count and up to five requests to
replay, writes every violation to `--out`/violations.json (and the sample to samples.json), and exits 1 if any
count is not zero. See README.md.
"""
import argparse, collections, concurrent.futures as cf, json, os, subprocess, sys, threading, time, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compare as C

NAMES = {
    1: 'guessed end labelled step-free',
    2: 'step-free profile: guessed end without its alert',
    3: 'straight line through a building, not marked a guess (or step-free)',
    4: 'times: legs out of order, journey bounds, arrive-by deadline',
    5: 'reach: over the limit, or lost with a longer limit',
    6: 'error, non-200, timeout or unreadable answer',
}


def post(base, path, body, timeout):
    """(status, answer): status 0 for no answer (a timeout, a refused connection), the answer None unless it is 200."""
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode(errors='replace')[:300]}
    except Exception as e:  # noqa: BLE001 - a failed request is a finding too
        return 0, {'error': f'{type(e).__name__}: {e}'[:300]}


class Audit:
    def __init__(self, engine):
        self.engine = engine
        self.found = collections.defaultdict(list)
        self.seen = {}
        self.lock = threading.Lock()
        self.no_stop = 0  # answers "no stop within walking distance" (not violations)

    def add(self, inv, path, body, what, dedup=None, **detail):
        """One violation. `dedup` names the finding: the same one again (the same walk in another journey, on a page,
        for another trip) is counted once, with the number of answers it is in."""
        with self.lock:
            if dedup is not None and (inv, dedup) in self.seen:
                self.seen[(inv, dedup)]['answers'] += 1
                return
            v = {'endpoint': path, 'body': body, 'what': what, 'answers': 1, **detail}
            if dedup is not None:
                self.seen[(inv, dedup)] = v
            self.found[inv].append(v)

    def ask(self, path, body, timeout):
        """The answer, or None after counting the failure under 6. Not a failure: the engine's answer that no stop is
        within walking distance of a place (HTTP 400, a remote place: main answers so too), counted on its own."""
        status, r = post(self.engine, path, body, timeout)
        if status == 400 and isinstance(r, dict) and 'within walking distance' in str(r.get('error', '')):
            with self.lock:
                self.no_stop += 1
            return None
        if status != 200 or not isinstance(r, dict) or 'error' in r:
            self.add(6, path, body, f'HTTP {status}: {(r or {}).get("error", "")}'[:200], status=status)
            return None
        return r


def walk_key(prof, w):
    """A walk leg as itself (the same change in many journeys is one walk)."""
    return (prof, w.get('kind'), json.dumps(w.get('geometry')))


def guessed(w):
    return w.get('approxStart') is not None or w.get('approxEnd') is not None


def has_unsure_alert(alerts, leg):
    return any(a.get('kind') == 'other' and 'step-free' in a.get('text', '') and (leg is None or a.get('leg') == leg) for a in alerts or [])


def ride_dep(l):
    return l['from']['dep'] + (l['from'].get('depDelayS') or 0)


def ride_arr(l):
    return l['to']['arr'] + (l['to'].get('arrDelayS') or 0)


def leg_times(l):
    return (ride_dep(l), ride_arr(l)) if l.get('type') == 'ride' else (l['dep'], l['arr'])


def check_journey(au, path, body, j, prof, deadline, walk_only, legs_out, tag):
    """Invariants 1, 2 and 4 of one journey; its walk legs (to test for 3) go to `legs_out`."""
    legs = j.get('legs') or []
    jid = (tag, j.get('id'))
    for i, l in enumerate(legs):
        if l.get('type') != 'walk':
            continue
        k = walk_key(prof, l)
        if guessed(l) and l.get('stepFree'):
            au.add(1, path, body, f"leg {i} ({l.get('kind')}) approx [{l.get('approxStart')}, {l.get('approxEnd')}] stepFree",
                   dedup=k, journey=j.get('id'), leg=i)
        if prof != 'normal' and guessed(l) and not has_unsure_alert(j.get('alerts'), None if walk_only else i):
            au.add(2, path, body, f"leg {i} ({l.get('kind')}) approx [{l.get('approxStart')}, {l.get('approxEnd')}], no alert",
                   dedup=k, journey=j.get('id'), leg=i, alerts=j.get('alerts', []))
        legs_out.append({'path': path, 'body': body, 'leg': i, 'journey': j.get('id'), 'w': l, 'dedup': k})
    if not legs:
        return
    bad = []
    times = [leg_times(l) for l in legs]
    for i, (d, a) in enumerate(times):
        if a < d:
            bad.append(f'leg {i} arrives {d - a} s before it leaves')
        if i:
            pa = times[i - 1][1]
            if d < pa:
                prev, cur = legs[i - 1].get('type'), legs[i].get('type')
                if cur == 'ride' and prev == 'walk':
                    bad.append(f'leg {i} (ride) boarded {pa - d} s before the walk before it ends')
                else:
                    bad.append(f'leg {i} ({cur}) leaves {pa - d} s before leg {i - 1} ({prev}) arrives')
    if j.get('dep') != times[0][0]:
        bad.append(f"journey dep {j.get('dep')} is not its first leg's {times[0][0]} ({j.get('dep') - times[0][0]:+d} s)")
    if j.get('arr') != times[-1][1]:
        bad.append(f"journey arr {j.get('arr')} is not its last leg's {times[-1][1]} ({j.get('arr') - times[-1][1]:+d} s)")
    if deadline is not None and j.get('arr') > deadline:
        bad.append(f"arrives {j.get('arr') - deadline} s after the deadline {deadline}")
    for b in bad:
        au.add(4, path, body, b, dedup=(jid, b), journey=j.get('id'))


def plan_job(au, trip, prof, arrive_by, timeout):
    t = trip
    base = {'from': C.place(t['from']), 'to': C.place(t['to']), 'options': C.PROFILES[prof]}
    if arrive_by:
        body = {**base, 'time': C.DAY0 + (t['hour'] + 3) * 3600, 'arriveBy': True}
    else:
        body = {**base, 'time': C.DAY0 + t['hour'] * 3600}
    out = []
    r = au.ask('/api/plan', body, timeout)
    # the deadline holds for the arrive-by answer only: its pages ask for departures before or after a time
    answers = [(body, r, body['time'] if arrive_by else None)]
    if r is not None:
        for cur in ('earlier', 'later'):
            if r.get(cur):
                pb = {**base, 'page': r[cur]}
                answers.append((pb, au.ask('/api/plan', pb, timeout), None))
    for b, a, deadline in answers:
        if a is None:
            continue
        try:
            tag = (json.dumps(base, sort_keys=True), prof)
            for j in a.get('journeys') or []:
                check_journey(au, '/api/plan', b, j, prof, deadline, False, out, tag)
            if a.get('walkOnly'):
                # walking only (no deadline: it starts at the latest journey's departure, or at the deadline itself)
                check_journey(au, '/api/plan', b, a['walkOnly'], prof, None, True, out, tag)
        except (KeyError, TypeError) as e:
            au.add(6, '/api/plan', b, f'unreadable answer: {type(e).__name__} {e}')
    return out


def walk_job(au, w, prof, timeout):
    body = {'from': C.place(w['from']), 'to': C.place(w['to']), 'options': C.PROFILES[prof]}
    r = au.ask('/api/walk', body, timeout)
    if r is None:
        return []
    if 'geometry' not in r:
        au.add(6, '/api/walk', body, 'unreadable answer: no geometry')
        return []
    k = walk_key(prof, r)
    if guessed(r) and r.get('stepFree'):
        au.add(1, '/api/walk', body, f"approx [{r.get('approxStart')}, {r.get('approxEnd')}] stepFree", dedup=k)
    return [{'path': '/api/walk', 'body': body, 'leg': None, 'journey': None, 'w': r, 'dedup': k}]


def reach_job(au, p, prof, timeout):
    sets = []
    for lim in C.LIMITS:
        body = {'from': C.place(p), 'options': {'maxWalkMin': lim, **C.PROFILES[prof]}}
        r = au.ask('/api/reach', body, timeout)
        if r is None:
            return
        try:
            # [id, seconds] from main, [id, seconds, how] from the branch
            s = {x[0]: x[1] for x in r.get('stops', [])}
        except (IndexError, TypeError) as e:
            au.add(6, '/api/reach', body, f'unreadable answer: {type(e).__name__} {e}')
            return
        over = {k: v for k, v in s.items() if v > lim * 60}
        if over:
            au.add(5, '/api/reach', body, f'{len(over)} stops over {lim * 60} s: ' + ', '.join(f'{k} {v} s' for k, v in list(over.items())[:3]), stops=over)
        sets.append((lim, body, s))
    for (l0, b0, s0), (l1, b1, s1) in zip(sets, sets[1:]):
        lost = {k: v for k, v in s0.items() if k not in s1}
        if lost:
            au.add(5, '/api/reach', b1, f'{len(lost)} stops reached in {l0} min and not in {l1}: ' + ', '.join(f'{k} ({v} s)' for k, v in list(lost.items())[:3]),
                   stops=lost, shorter=b0)


def through(au, args, legs):
    """Invariant 3: the straight lines of each leg (outside its `network` range) that run through a building."""
    rows, keep = [], []
    for k, x in enumerate(legs):
        w = x['w']
        g = w.get('geometry') or []
        if w.get('approximate') or len(g) < 2:
            continue  # a straight line from end to end, marked a guess as a whole
        n0, n1 = C.ends_of(w, 'b')
        ends = ([[n0 - 1, False]] if n0 > 0 else []) + ([[n1, True]] if n1 < len(g) - 1 else [])
        rows.append(json.dumps({'key': k, 'geometry': g, 'ends': ends}))
        keep.append(k)
    if not rows:
        return {'legs': 0, 'network_through': 0}
    r = subprocess.run([args.bin, 'through', args.data], input='\n'.join(rows) + '\n', capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'compare through failed: {r.stderr[-500:]}')
    net_through = 0
    for line in r.stdout.splitlines():
        v = json.loads(line)
        x = legs[v['key']]
        w, segs = x['w'], v['through']
        if not segs:
            continue
        n0, n1 = C.ends_of(w, 'b')
        a0, a1 = w.get('approxStart'), w.get('approxEnd')
        conn = [s for s in segs if s < n0 or s >= n1]
        covered = [(c['from'], c['to']) for c in w.get('covered', [])]
        if any(n0 <= s < n1 and not any(a <= s < b for a, b in covered) for s in segs):
            net_through += 1
        unmarked = [s for s in conn if not ((a0 is not None and s < a0) or (a1 is not None and s >= a1))]
        step_free = bool(conn) and bool(w.get('stepFree'))
        if unmarked or step_free:
            what = (f"leg {x['leg']} ({w.get('kind')}) " if x['leg'] is not None else '') + \
                   f"segments {conn} through a building; network {[n0, n1]}, approx [{a0}, {a1}], stepFree {w.get('stepFree')}"
            au.add(3, x['path'], x['body'], what, dedup=x['dedup'], journey=x['journey'], leg=x['leg'], segments=conn, unmarked=unmarked,
                   lines=[g for s in conn for g in [w['geometry'][s:s + 2]]])
    return {'legs': len(rows), 'network_through': net_through}


def examples(vs, n=5):
    """Up to n violations, of different places where there are (the same trip asked again is not another example)."""
    place = lambda v: json.dumps([v['body'].get('from'), v['body'].get('to')], sort_keys=True)
    seen, out = set(), []
    for v in vs:
        if place(v) not in seen and len(out) < n:
            seen.add(place(v))
            out.append(v)
    return out + [v for v in vs if v not in out][:n - len(out)]


def curl(engine, v):
    return f"curl -s {engine}{v['endpoint']} -H 'content-type: application/json' -d '{json.dumps(v['body'], separators=(',', ':'))}'"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--engine', required=True)
    ap.add_argument('--data', required=True, help="the engine's data dir (its building outlines for the test of 3)")
    ap.add_argument('--bin', required=True, help='the compare binary')
    ap.add_argument('--seed', type=int, required=True)
    ap.add_argument('--points', type=int, default=5000)
    ap.add_argument('--trips', type=int, default=1000)
    ap.add_argument('--out', help='where violations.json and samples.json go (default audit-<seed>)')
    ap.add_argument('--threads', type=int, default=32)
    ap.add_argument('--timeout', type=float, default=120, help='seconds per request (a timeout counts under 6)')
    args = ap.parse_args()
    out = args.out or f'audit-{args.seed}'
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    log = lambda m: print(f'[{time.time() - t0:6.0f} s] {m}', file=sys.stderr, flush=True)

    r = subprocess.run([args.bin, 'sample', args.data, str(args.points), str(args.seed)], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'compare sample failed: {r.stderr[-500:]}')
    S = json.loads(r.stdout)
    S['trips'] = S['trips'][:args.trips]
    with open(os.path.join(out, 'samples.json'), 'w') as f:
        json.dump(S, f)
    log(f"sample: {len(S['points'])} points, {len(S['walks'])} walks, {len(S['trips'])} trips")

    au = Audit(args.engine.rstrip('/'))
    pool = cf.ThreadPoolExecutor(args.threads)

    def run(name, fn, jobs):
        res = []
        futs = [pool.submit(fn, *j) for j in jobs]
        for n, f in enumerate(cf.as_completed(futs)):
            try:
                res.append(f.result())
            except Exception as e:  # noqa: BLE001 - a checker that trips on an answer is a finding, not the end
                au.add(6, '?', {}, f'checker failed: {type(e).__name__} {e}')
            if n % 2000 == 1999:
                log(f'  {name} {n + 1}/{len(jobs)}')
        log(f'{name}: {len(jobs)} done')
        return res

    legs = []
    for x in run('plans', lambda t, p, ab: plan_job(au, t, p, ab, args.timeout), [(t, p, ab) for t in S['trips'] for p in C.PROFILES for ab in (False, True)]):
        legs += x or []
    for x in run('walks', lambda w, p: walk_job(au, w, p, args.timeout), [(w, p) for w in S['walks'] for p in C.PROFILES]):
        legs += x or []
    run('reach', lambda p, prof: reach_job(au, p, prof, args.timeout), [(p, prof) for p in S['points'] for prof in C.PROFILES])
    log(f'through: {len(legs)} walk legs')
    try:
        th = through(au, args, legs)
    except Exception as e:  # noqa: BLE001
        th = {'error': str(e)}
        au.add(6, '(compare through)', {}, f'invariant 3 not checked: {e}')

    log('through: done')
    counts = {i: len(au.found[i]) for i in NAMES}
    print(f"audit of {args.engine}, seed {args.seed}: {len(S['points'])} points, {len(S['walks'])} walks, {len(S['trips'])} trips; "
          f"{th.get('legs', '?')} walk legs tested for 3 ({th.get('network_through', '?')} with a mapped way through a building, not counted); "
          f"{au.no_stop} answers 'no stop within walking distance' (a remote place, not counted)")
    for i, name in NAMES.items():
        vs = au.found[i]
        print(f'{i}. {name}: {len(vs)}' + (f" (in {sum(v['answers'] for v in vs)} answers)" if any(v['answers'] > 1 for v in vs) else ''))
        if i == 6 and vs:
            by = collections.Counter(v['what'][:90] for v in vs)
            for what, n in by.most_common(5):
                print(f'     {n:6d} × {what}')
        for v in examples(vs):
            print(f"   - {v['what']}" + (f" (in {v['answers']} answers)" if v['answers'] > 1 else '') + f"\n     {curl(au.engine, v)}")
    path = os.path.join(out, 'violations.json')
    with open(path, 'w') as f:
        json.dump({'engine': args.engine, 'seed': args.seed, 'points': args.points, 'trips': len(S['trips']), 'through': th,
                   'counts': {NAMES[i]: n for i, n in counts.items()}, 'violations': {str(i): au.found[i] for i in NAMES}}, f, indent=1)
    print(f'all violations: {path}')
    sys.exit(1 if any(counts.values()) else 0)


if __name__ == '__main__':
    main()
