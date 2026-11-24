"""The review's cases, each checked against a running engine (B), with A's (main's) answer beside it for reference.

    python3 regressions.py --a http://127.0.0.1:8091 --b http://127.0.0.1:8092

Exit code 1 if any case fails on B. Times are from midnight on Tuesday 24 November 2026 in Zürich (compare.DAY0).
"""
import argparse, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compare as C

ap = argparse.ArgumentParser()
ap.add_argument('--a', required=True)
ap.add_argument('--b', required=True)
args = ap.parse_args()
P = C.PROFILES
dist = lambda a, b: math.hypot((a[0] - b[0]) * math.cos(math.radians(a[1])) * 111320, (a[1] - b[1]) * 111320)
failed = 0


def case(name, ok, b_says, a_says=''):
    global failed
    failed += not ok
    print(f"{'ok  ' if ok else 'FAIL'}  {name}\n      branch: {b_says}" + (f"\n      main:   {a_says}" if a_says else ''))


def walk(e, frm, to, prof):
    return C.post(e, '/api/walk', {'from': frm, 'to': to, 'options': P[prof]})[0]


def reach(e, frm, prof, lim):
    r = C.post(e, '/api/reach', {'from': frm, 'options': {'maxWalkMin': lim, **P[prof]}})[0]
    return {x[0]: x[1] for x in r.get('stops', [])}


def plan(e, frm, to, hour, prof, **kw):
    return C.post(e, '/api/plan', {'from': frm, 'to': to, 'time': C.DAY0 + hour * 3600, 'options': P[prof], **kw}, 120)[0]


# 1. snapping, walk #16572: a 26 m guessed start, labelled step-free, where main starts on the footbridge 1.64 m away
frm, to = {'lat': 47.546155, 'lon': 7.758926, 'name': 'street'}, {'lat': 47.5500, 'lon': 7.7630, 'name': 'address'}
for prof in P:
    wb, wa = walk(args.b, frm, to, prof), walk(args.a, frm, to, prof)
    first = lambda w: dist(w['geometry'][0], w['geometry'][1]) if len(w.get('geometry', [])) > 1 else None
    ok = first(wb) is not None and first(wb) < 3.0 and wb.get('approxStart') is None
    case(f'#16572 {prof}: starts on a way at hand (under 3 m), not a guess', ok,
         f"first line {first(wb):.2f} m, approxStart {wb.get('approxStart')}, stepFree {wb.get('stepFree')}", f"first line {first(wa):.2f} m")

# 2. rounding, Geneva point #13520: a clear walk within 10 minutes, dropped by rounding
frm, stop = {'lat': 46.194838, 'lon': 6.145331, 'name': 'street'}, 'ch:1:sloid:95021:0:22341'
rb, ra = reach(args.b, frm, 'normal', 10), reach(args.a, frm, 'normal', 10)
case(f'#13520 normal 10 min: {stop} reached', stop in rb, f'{rb.get(stop)} s', f'{ra.get(stop)} s')

# 3. the step-free rule: more time never loses a stop (#846), and no trip hours later where main walks step-free (#4460)
frm = {'lat': 46.750593, 'lon': 7.208789, 'name': 'address'}
for prof in P:
    sets = [reach(args.b, frm, prof, lim) for lim in (5, 10, 20)]
    lost = [s for k in range(2) for s in sets[k] if s not in sets[k + 1]]
    case(f'#846 {prof}: a stop reached in 5 or 10 min is reached with more time', not lost, f'{len(lost)} lost with more time: {lost[:3]}')
frm, to = {'lat': 46.075076, 'lon': 9.0179, 'name': 'address'}, {'lat': 46.179886, 'lon': 8.799636, 'name': 'address'}
pb, pa = plan(args.b, frm, to, 8, 'wheelchair'), plan(args.a, frm, to, 8, 'wheelchair')
first_arr = lambda p: min((j['arr'] for j in p.get('journeys') or []), default=None)
ab, aa = first_arr(pb), first_arr(pa)
case('#4460 wheelchair 08:00: arrives no later than main (5 min)', ab is not None and (aa is None or ab <= aa + 300), f'first arrival {ab}', f'{aa}')

# 4. a wheelchair walking-only answer with a guessed end says so (walk #20)
w20 = {'from': {'lat': 47.096772, 'lon': 7.129509, 'name': 'address'}, 'to': {'lat': 47.099791, 'lon': 7.131613, 'name': 'address'}}
pb = plan(args.b, w20['from'], w20['to'], 12, 'wheelchair')
wo = pb.get('walkOnly') or {}
leg = (wo.get('legs') or [{}])[0]
guessed = leg.get('approxStart') is not None or leg.get('approxEnd') is not None
said = any(a.get('kind') == 'other' and 'step-free' in a.get('text', '') for a in wo.get('alerts') or [])
case('#20 wheelchair walking only: a guessed end carries the alert', not guessed or said or leg.get('stepFree'),
     f"approxStart {leg.get('approxStart')} approxEnd {leg.get('approxEnd')} stepFree {leg.get('stepFree')} alert {said}")

# 6. timed and drawn agree: trip #4644's egress (normal, 23:00) takes what the walk from its stop takes
frm, to = {'lat': 47.450808, 'lon': 7.805682, 'name': 'address'}, {'lat': 47.046756, 'lon': 8.301144, 'name': 'address'}
pb = plan(args.b, frm, to, 23, 'normal')
bad = []
for j in pb.get('journeys') or []:
    for l in j['legs']:
        if l.get('type') == 'walk' and l.get('kind') in ('access', 'egress') and not l.get('approximate'):
            end = l['to'] if l['kind'] == 'egress' else l['from']
            q = (l['from'] if l['kind'] == 'egress' else l['to']).get('quay') or {}
            if not q.get('sloid') and not q.get('id'):
                continue
            ref = {'quay': q.get('sloid') or q.get('id')}
            wq = walk(args.b, ref, to, 'normal') if l['kind'] == 'egress' else walk(args.b, frm, ref, 'normal')
            if abs(wq.get('durationS', 0) - l['durationS']) > 1:
                bad.append((l['kind'], l['durationS'], wq.get('durationS')))
case('#4644 normal 23:00: each first and last walk takes what the same walk asked alone takes (within 1 s)', not bad, f'{len(bad)} differ: {bad[:3]}')

print(f"\n{'all passed' if not failed else f'{failed} failed'}")
sys.exit(1 if failed else 0)
