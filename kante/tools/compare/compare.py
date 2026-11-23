#!/usr/bin/env python3
"""Compare two running engines (A: the reference, usually `main`; B: the change) on the same samples.

    compare.py --a http://127.0.0.1:8091 --b http://127.0.0.1:8092 --samples samples.json \
               --data-a A-data-dir --data-b B-data-dir --bin path/to/compare --out results/ [--threads 32]

Samples come from `compare sample` (crates/link/src/bin/compare.rs). Writes every answer to `--out` and a summary
(`summary.json`): reach (the stops walked to from each point, three profiles, three limits, every stop A reaches
and B does not with its cause from the built data: `compare explain`), walks, lines through buildings (an
independent sampled test: `compare through`), plans (every trip that loses its journey or arrives more than five
minutes later, with its cause), and cost. See README.md.
"""
import argparse, collections, concurrent.futures as cf, json, os, subprocess, sys, time, urllib.request

LIMITS = [5, 10, 20]
PROFILES = {'normal': {}, 'stepfree': {'stairs': 'never', 'escalators': False}, 'wheelchair': {'stairs': 'never', 'escalators': False, 'wheelchair': True}}
DAY0 = 1795489200  # Tuesday 2026-11-24 00:00 in Zürich


def post(base, path, body, timeout=60):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()), time.perf_counter() - t
    except urllib.error.HTTPError as e:
        return {'error': e.read().decode(errors='replace')[:300]}, time.perf_counter() - t
    except Exception as e:  # noqa: BLE001 - a failed request is a result too
        return {'error': str(e)}, time.perf_counter() - t


def run(pool, fn, items):
    out = [None] * len(items)
    futs = {pool.submit(fn, it): i for i, it in enumerate(items)}
    for n, f in enumerate(cf.as_completed(futs)):
        out[futs[f]] = f.result()
        if n % 20000 == 19999:
            print(f'  {n + 1}/{len(items)}', file=sys.stderr)
    return out


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))]


def place(p):
    return {'id': p['id']} if p.get('id') else {'lat': p['lat'], 'lon': p['lon'], 'name': p['kind']}


def stops_of(r):
    """{stop id: (seconds, how)} from a /api/reach answer ([id, s] from A, [id, s, how] from B)."""
    return {x[0]: (x[1], x[2] if len(x) > 2 else '') for x in r.get('stops', [])}


def explain(args, records):
    """Each lost stop's cause from the built data of both engines (`compare explain`), and with `--main-probe`
    whether A's own search code, run on B's graph from A's start to B's link, reaches it within the limit: if it does
    not, the stop is lost by the graph (or the link), not by B's code."""
    if not records:
        return []
    inp = '\n'.join(json.dumps(r) for r in records) + '\n'
    out = subprocess.run([args.bin, 'explain', args.data_a, args.data_b], input=inp, capture_output=True, text=True, check=True).stdout
    res = [json.loads(x) for x in out.splitlines()]
    if args.main_probe:
        probe = subprocess.run([args.main_probe, os.path.join(args.data_b, 'built/walkgraph.bin')], input=out, capture_output=True, text=True, check=True).stdout
        reach = {json.dumps(json.loads(x)['key']): json.loads(x)['a_code_on_b_graph'] for x in probe.splitlines()}
        for r in res:
            r['a_code_on_b_graph'] = reach.get(json.dumps(r['key']))
            if r['cause'] == 'unexplained' and r['a_code_on_b_graph'] is None:
                r['cause'] = "graph: not pinned to one edge (A's own search on B's graph does not reach it either)"
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--a', required=True)
    ap.add_argument('--b', required=True)
    ap.add_argument('--samples', required=True)
    ap.add_argument('--data-a', required=True)
    ap.add_argument('--data-b', required=True, help="B's data dir (its building outlines too)")
    ap.add_argument('--bin', required=True, help='the compare binary')
    ap.add_argument('--out', required=True)
    ap.add_argument('--threads', type=int, default=32)
    ap.add_argument('--only', default='reach,walks,plans,cost')
    ap.add_argument('--main-probe', help="main-probe.rs built in A's worktree (README): A's own search on B's graph")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    S = json.load(open(args.samples))
    only = set(args.only.split(','))
    pool = cf.ThreadPoolExecutor(args.threads)
    summary = {'samples': collections.Counter(p['kind'] for p in S['points'])}

    if 'reach' in only:
        jobs = [(i, prof, lim) for i in range(len(S['points'])) for prof in PROFILES for lim in LIMITS]
        def reach(job):
            i, prof, lim = job
            body = {'from': place(S['points'][i]), 'options': {'maxWalkMin': lim, **PROFILES[prof]}}
            return [post(e, '/api/reach', body)[0] for e in (args.a, args.b)]
        res = run(pool, reach, jobs)
        with open(os.path.join(args.out, 'reach.jsonl'), 'w') as f:
            for job, (ra, rb) in zip(jobs, res):
                f.write(json.dumps({'point': job[0], 'profile': job[1], 'limit': job[2], 'a': ra, 'b': rb}) + '\n')
        summary['reach'] = reach_summary(args, S, jobs, res)

    if 'walks' in only:
        jobs = [(i, prof) for i in range(len(S['walks'])) for prof in PROFILES]
        def walk(job):
            i, prof = job
            w = S['walks'][i]
            body = {'from': place(w['from']), 'to': place(w['to']), 'options': PROFILES[prof]}
            return [post(e, '/api/walk', body)[0] for e in (args.a, args.b)]
        res = run(pool, walk, jobs)
        with open(os.path.join(args.out, 'walks.jsonl'), 'w') as f:
            for job, (wa, wb) in zip(jobs, res):
                f.write(json.dumps({'walk': job[0], 'profile': job[1], 'a': wa, 'b': wb}) + '\n')
        summary['walks'] = walk_summary(S, jobs, res)
        summary['through'] = through_summary(args, jobs, res)

    if 'plans' in only:
        jobs = list(range(len(S['trips'])))
        def body_of(i):
            t = S['trips'][i]
            return {'from': place(t['from']), 'to': place(t['to']), 'time': DAY0 + t['hour'] * 3600, 'options': PROFILES[t['profile']]}
        res = run(pool, lambda i: [post(e, '/api/plan', body_of(i), 120)[0] for e in (args.a, args.b)], jobs)
        with open(os.path.join(args.out, 'plans.jsonl'), 'w') as f:
            for i, (pa, pb) in zip(jobs, res):
                f.write(json.dumps({'trip': i, 'a': pa, 'b': pb}) + '\n')
        summary['plans'] = plan_summary(args, S, jobs, res)

    if 'cost' in only:
        summary['cost'] = cost(args, S)

    json.dump(summary, open(os.path.join(args.out, 'summary.json'), 'w'), indent=1)
    print(json.dumps(summary, indent=1))


def reach_summary(args, S, jobs, res):
    out = {}
    lost_records = []
    for (i, prof, lim), (ra, rb) in zip(jobs, res):
        if 'error' in ra or 'error' in rb:
            continue
        a, b = stops_of(ra), stops_of(rb)
        for s, (t, _) in a.items():
            if s not in b:
                lost_records.append({'key': [i, prof, lim, s], 'point': S['points'][i], 'options': PROFILES[prof], 'limit': lim, 'stop': s, 'a_secs': t})
    causes = {tuple(x['key']): x for x in explain(args, lost_records)}
    with open(os.path.join(args.out, 'lost.jsonl'), 'w') as f:
        for r in lost_records:
            c = causes.get(tuple(r['key']), {})
            f.write(json.dumps({**r, 'cause': c.get('cause'), 'reproduced': c.get('reproduced'), 'a_code_on_b_graph': c.get('a_code_on_b_graph')}) + '\n')
    for prof in PROFILES:
        for lim in LIMITS:
            st = {'points': 0, 'errors': 0, 'stops_a': 0, 'stops_b': 0, 'lost': 0, 'gained': 0, 'later': [], 'earlier': 0, 'same': 0,
                  'causes': collections.Counter(), 'later_via': collections.Counter(), 'lost_by_kind': collections.Counter()}
            for (i, p, l), (ra, rb) in zip(jobs, res):
                if p != prof or l != lim:
                    continue
                st['points'] += 1
                if 'error' in ra or 'error' in rb:
                    st['errors'] += 1
                    continue
                a, b = stops_of(ra), stops_of(rb)
                st['stops_a'] += len(a)
                st['stops_b'] += len(b)
                st['gained'] += sum(1 for s in b if s not in a)
                for s, (t, _) in a.items():
                    if s not in b:
                        st['lost'] += 1
                        c = causes.get((i, p, l, s), {})
                        st['causes'][(c.get('cause') or '?').split(' (')[0]] += 1
                        st['lost_by_kind'][S['points'][i]['kind']] += 1
                    else:
                        d = b[s][0] - t
                        if d > 0:
                            st['later'].append(d)
                            st['later_via'][b[s][1]] += 1
                        elif d < 0:
                            st['earlier'] += 1
                        else:
                            st['same'] += 1
            later = st.pop('later')
            st['later'] = len(later)
            st['later_s_p50_p95_max'] = [pct(later, 50), pct(later, 95), max(later) if later else None]
            st['later_over_60s'] = sum(1 for d in later if d > 60)
            out[f'{prof} {lim} min'] = st
    out['unreproduced'] = sum(1 for c in causes.values() if not c.get('reproduced'))
    out['a_code_on_b_graph_reaches'] = sum(1 for c in causes.values() if c.get('a_code_on_b_graph') is not None)
    return out


def walk_summary(S, jobs, res):
    out = {}
    for prof in PROFILES:
        st = {'pairs': 0, 'a_routed': 0, 'b_routed': 0, 'routed_a_not_b': [], 'ratios_dist': [], 'ratios_time': [], 'over_1_5': []}
        for (i, p), (wa, wb) in zip(jobs, res):
            if p != prof:
                continue
            st['pairs'] += 1
            ra = 'error' not in wa and not wa.get('approximate')
            rb = 'error' not in wb and not wb.get('approximate')
            st['a_routed'] += ra
            st['b_routed'] += rb
            if ra and not rb:
                st['routed_a_not_b'].append({'walk': i, 'from': S['walks'][i]['from'], 'to': S['walks'][i]['to']})
            if ra and rb and wa['distanceM'] > 0:
                rd, rt = wb['distanceM'] / wa['distanceM'], wb['durationS'] / max(1, wa['durationS'])
                st['ratios_dist'].append(rd)
                st['ratios_time'].append(rt)
                if rd > 1.5 or rt > 1.5:
                    st['over_1_5'].append({'walk': i, 'a_m': wa['distanceM'], 'b_m': wb['distanceM'], 'a_s': wa['durationS'], 'b_s': wb['durationS'],
                                           'from': S['walks'][i]['from'], 'to': S['walks'][i]['to'], 'b_start_door': bool(wb.get('startDoor')), 'b_door': bool(wb.get('door')),
                                           'b_guess': [wb.get('approxStart'), wb.get('approxEnd')]})
        rd, rt = st.pop('ratios_dist'), st.pop('ratios_time')
        st['ratio_dist_p5_p50_p95_max'] = [pct(rd, 5), pct(rd, 50), pct(rd, 95), max(rd) if rd else None]
        st['ratio_time_p5_p50_p95_max'] = [pct(rt, 5), pct(rt, 50), pct(rt, 95), max(rt) if rt else None]
        st['count_over_1_5'] = len(st['over_1_5'])
        out[prof] = st
    return out


def ends_of(w, side):
    """The first and last vertex on the network: B says (`network`); A draws one straight line at each end."""
    nv = len(w['geometry'])
    if side == 'b' and w.get('network'):
        return tuple(w['network'])
    return (1 if nv > 2 else 0), (nv - 2 if nv > 2 else nv - 1)


def through_summary(args, jobs, res):
    """The straight segments of each walk that run through a building (B's outlines, sampled), and how drawn."""
    lines = []
    for n, ((i, p), (wa, wb)) in enumerate(zip(jobs, res)):
        for side, w in (('a', wa), ('b', wb)):
            if 'error' not in w and not w.get('approximate'):
                # a straight line onto a way under a roof (an arcade): its last 5 m are exempt, as in the engine
                n0, n1 = ends_of(w, side)
                cov = [(c['from'], c['to']) for c in w.get('covered', [])]
                arcade = ([[n0 - 1, False]] if n0 > 0 and any(a <= n0 <= b for a, b in cov) else []) + \
                         ([[n1, True]] if n1 < len(w['geometry']) - 1 and any(a <= n1 <= b for a, b in cov) else [])
                lines.append(json.dumps({'key': [n, side], 'geometry': w['geometry'], 'arcade': arcade}))
    r = subprocess.run([args.bin, 'through', args.data_b], input='\n'.join(lines) + '\n', capture_output=True, text=True, check=True)
    hits = {}
    for line in r.stdout.splitlines():
        v = json.loads(line)
        hits[tuple(v['key'])] = v['through']
    out = {}
    for side in ('a', 'b'):
        st = {'walks': 0, 'with_connector_through': 0, 'connector_through_drawn_solid': 0, 'connector_through_step_free': 0, 'network_through': 0, 'solid_examples': []}
        for n, ((i, p), ws) in enumerate(zip(jobs, res)):
            w = ws[0] if side == 'a' else ws[1]
            if (n, side) not in hits:
                continue
            st['walks'] += 1
            n0, n1 = ends_of(w, side)
            covered = [(c['from'], c['to']) for c in w.get('covered', [])]
            segs = hits[(n, side)]
            conn = [s for s in segs if s < n0 or s >= n1]
            net = [s for s in segs if n0 <= s < n1 and not any(a <= s < b for a, b in covered)]
            if net:
                st['network_through'] += 1
            if conn:
                st['with_connector_through'] += 1
                a0, a1 = w.get('approxStart'), w.get('approxEnd')
                solid = [s for s in conn if not ((a0 is not None and s < a0) or (a1 is not None and s >= a1))]
                if solid:
                    st['connector_through_drawn_solid'] += 1
                    if len(st['solid_examples']) < 30:
                        st['solid_examples'].append({'walk': i, 'profile': p, 'segments': solid, 'geometry': [w['geometry'][s:s + 2] for s in solid]})
                if w.get('stepFree'):
                    st['connector_through_step_free'] += 1
        out[side] = st
    return out


def legs_of(p):
    """The earliest-arriving journey's access and egress ((stop id, seconds) each) and changes ((from, to) ids)."""
    js = [] if 'error' in p else p.get('journeys', [])
    if not js:
        return None
    j = min(js, key=lambda j: j['arr'])
    acc = next((l for l in j['legs'] if l.get('kind') == 'access'), None)
    egr = next((l for l in j['legs'] if l.get('kind') == 'egress'), None)
    q = lambda l, k: ((l or {}).get(k) or {}).get('quay', {}).get('id')
    # a change: the ride before's last stop to the ride after's first (on foot, or staying at the stop)
    rides = [l for l in j['legs'] if l.get('type') == 'ride']
    changes = [(q(a, 'to'), q(b, 'from')) for a, b in zip(rides, rides[1:]) if not b.get('stayOnBoard')]
    return {'arr': j['arr'], 'access': (q(acc, 'to'), acc and acc['durationS']), 'egress': (q(egr, 'from'), egr and egr['durationS']), 'changes': changes}


def plan_summary(args, S, jobs, res):
    st = {'trips': len(jobs), 'a_journey': 0, 'b_journey': 0, 'earlier': 0, 'same': 0, 'later': [], 'worse': []}
    for i, (pa, pb) in zip(jobs, res):
        ja = [] if 'error' in pa else pa.get('journeys', [])
        jb = [] if 'error' in pb else pb.get('journeys', [])
        st['a_journey'] += bool(ja)
        st['b_journey'] += bool(jb)
        if ja and not jb:
            st['worse'].append({'trip': i, 'a_arr': min(j['arr'] for j in ja), 'b_arr': None})
        if ja and jb:
            aa, ab = min(j['arr'] for j in ja), min(j['arr'] for j in jb)
            if ab > aa:
                st['later'].append(ab - aa)
                if ab - aa > 300:
                    st['worse'].append({'trip': i, 'a_arr': aa, 'b_arr': ab})
            elif ab < aa:
                st['earlier'] += 1
            else:
                st['same'] += 1
    later = st.pop('later')
    st['later_count'] = len(later)
    st['later_s_p50_p95_max'] = [pct(later, 50), pct(later, 95), max(later) if later else None]
    # each worse trip: does B reach A's first and last stop, and when (the same 20 minutes the plan walks)?
    lost = []
    for w in st['worse']:
        t = S['trips'][w['trip']]
        la = legs_of(res[w['trip']][0])
        w['profile'] = t['profile']
        w['why'] = []
        for side, end in (('access', 'from'), ('egress', 'to')):
            stop, secs = la[side]
            if not stop:
                continue
            body = {'from': place(t[end]), 'options': {'maxWalkMin': 20, **PROFILES[t['profile']]}}
            b = stops_of(post(args.b, '/api/reach', body)[0])
            a = stops_of(post(args.a, '/api/reach', body)[0])
            if stop not in b:
                w['why'].append(f'{side} stop {stop} lost')
                lost.append({'key': [w['trip'], side], 'point': t[end], 'options': PROFILES[t['profile']], 'limit': 20, 'stop': stop, 'a_secs': a.get(stop, (secs, ''))[0]})
            elif stop in a and b[stop][0] > a[stop][0]:
                w['why'].append(f'{side} stop {stop} {b[stop][0] - a[stop][0]} s later on B (via {b[stop][1]})')
        # every change of A's journey: B's footpath for it (the step-free set for a step-free or wheelchair trip)
        fset = 'normal' if t['profile'] == 'normal' else 'step_free'
        ch = [c for c in la['changes'] if c[0] and c[1] and c[0] != c[1]]
        if ch:
            inp = '\n'.join(json.dumps({'key': k, 'set': fset, 'from': a, 'to': b}) for k, (a, b) in enumerate(ch)) + '\n'
            fps = [json.loads(x) for x in subprocess.run([args.bin, 'footpaths', args.data_a, args.data_b], input=inp, capture_output=True, text=True, check=True).stdout.splitlines()]
            for (a, b), f in zip(ch, fps):
                if f['a'] is not None and f['b'] is None:
                    w['why'].append(f'change {a} → {b} ({f["a"]:.0f} s on A) not a footpath on B')
                    lost.append({'key': [w['trip'], f'change {a}'], 'from_stop': a, 'point': {}, 'options': PROFILES[t['profile']], 'limit': 20, 'stop': b, 'a_secs': f['a']})
                elif f['a'] is not None and f['b'] > f['a'] + 1:
                    w['why'].append(f'change {a} → {b} {f["b"] - f["a"]:.0f} s longer on B')
        if not w['why']:
            w['why'].append('every walk of A\'s journey as quick on B: the search')
    for c in explain(args, lost):
        w = next(x for x in st['worse'] if x['trip'] == c['key'][0])
        tag = f"{c['key'][1]} stop" if c['key'][1] in ('access', 'egress') else c['key'][1]
        w['why'] = [x + f": {c['cause']}" if x.startswith(tag) and (x.endswith('lost') or x.endswith('not a footpath on B')) else x for x in w['why']]
    st['worse'].sort(key=lambda w: -((w['b_arr'] or 10**10) - w['a_arr']))
    return st


def cost(args, S):
    """Latency with 4 requests at a time (each engine on its own)."""
    out = {}
    pool = cf.ThreadPoolExecutor(4)
    for name, base in (('a', args.a), ('b', args.b)):
        walks = [{'from': place(w['from']), 'to': place(w['to'])} for w in S['walks'][:2000]]
        plans = [{'from': place(t['from']), 'to': place(t['to']), 'time': DAY0 + 8 * 3600} for t in S['trips'][:400]]
        tw = [x[1] for x in run(pool, lambda b: post(base, '/api/walk', b), walks)]
        tp = [x[1] for x in run(pool, lambda b: post(base, '/api/plan', b, 120), plans)]
        out[name] = {'walk_ms_p50_p95': [round(pct(tw, 50) * 1e3, 1), round(pct(tw, 95) * 1e3, 1)], 'plan_ms_p50_p95': [round(pct(tp, 50) * 1e3, 1), round(pct(tp, 95) * 1e3, 1)]}
    return out


if __name__ == '__main__':
    main()
