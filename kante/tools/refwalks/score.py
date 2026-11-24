#!/usr/bin/env python3
"""Scores an engine against the reference walks (refwalks.json).

    python3 -I score.py --set refwalks.json --engine http://127.0.0.1:8092 --data DATA --bin compare [--out FILE]
        [--time 2026-11-24T23:30]   (every walk asked for at that time: ways closed then are avoided)

DATA: a data dir whose graph and walkattr.bin `compare metrics` reads (any build of the same OpenStreetMap file: the
lines are matched by their geometry).

- Golden walks (checked by eye, one walk judged right): a walk passes when it uses at least 70 % of the metres the
  right walk spends on the ways only it uses (`must_use`), at most 15 m on the ways only the wrong one used
  (`must_avoid`), and, where the right walk's door is given, ends within 5 m of it. Reported by category, city and
  profile; a gain somewhere never hides a failure elsewhere (each failure is listed).
- Every walk: metres on carriageways whose sidewalks are drawn apart, on busy carriageways, on car-only roads,
  busy roads walked over from a footway where no crossing is mapped, `crossing=no` passed, metres on closed ways,
  turns, length and time.
"""
import argparse, collections, concurrent.futures as cf, json, math, subprocess, sys, urllib.request

PROFILES = {'normal': {}, 'stepfree': {'stairs': 'never', 'escalators': False, 'wheelchair': True}}


def post(base, body):
    req = urllib.request.Request(base + '/api/walk', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except Exception as ex:
        return {'error': str(ex)}


def dist(a, b):
    k = math.cos(math.radians(a[0]))
    return math.hypot((a[0] - b[0]) * 111195, (a[1] - b[1]) * 111195 * k)


def main():
    ap = argparse.ArgumentParser()
    for k in ['set', 'engine', 'data', 'bin']:
        ap.add_argument('--' + k, required=True)
    ap.add_argument('--out')
    ap.add_argument('--time', help='local time, YYYY-MM-DDTHH:MM (Europe/Zurich)')
    args = ap.parse_args()
    at = None
    if args.time:
        import datetime, zoneinfo
        at = int(datetime.datetime.fromisoformat(args.time).replace(tzinfo=zoneinfo.ZoneInfo('Europe/Zurich')).timestamp())
    W = json.load(open(args.set, encoding='utf-8'))['walks']

    def ask(w):
        b = {'from': {'lat': w['from'][0], 'lon': w['from'][1]}, 'to': {'lat': w['to'][0], 'lon': w['to'][1]}, 'options': PROFILES[w['profile']]}
        if at:
            b['time'] = at
        return post(args.engine, b)

    with cf.ThreadPoolExecutor(8) as ex:
        R = list(ex.map(ask, W))
    lines = [json.dumps({'key': w['id'], 'geometry': r['geometry']}) for w, r in zip(W, R) if r.get('geometry')]
    out = subprocess.run([args.bin, 'metrics', args.data], input='\n'.join(lines) + '\n', capture_output=True, text=True, check=True).stdout
    M = {m['key']: m for m in map(json.loads, out.splitlines())}

    tot = collections.Counter()
    groups = collections.defaultdict(lambda: [0, 0])
    fails = []
    per = []
    for w, r in zip(W, R):
        m = M.get(w['id'], {})
        c = w.get('check') or {}
        if 'error' in r or not m:
            tot['errors'] += 1
            # a golden walk without an answer is a failure, not left out of the count
            if c.get('golden'):
                for key in [('all',), ('category', w['category']), ('city', w['city']), ('profile', w['profile']), ('issue', c.get('issue'))]:
                    groups[key][1] += 1
                fails.append({'id': w['id'], 'category': w['category'], 'issue': c.get('issue'), 'why': ['no answer or no line: ' + str(r.get('error', ''))], 'check': c.get('reason')})
            continue
        for k in ['sep_m', 'busy_m', 'car_m', 'crossings', 'blocked', 'turns', 'len_m']:
            tot[k] += m.get(k, 0)
        tot['walks'] += 1
        tot['walks_sep'] += m.get('sep_m', 0) > 0
        tot['walks_cross'] += m.get('crossings', 0) > 0
        tot['closed_m'] += r.get('closedM', 0)
        tot['distance_m'] += r.get('distanceM', 0)
        tot['duration_s'] += r.get('durationS', 0)
        rec = {'id': w['id'], 'distanceM': r.get('distanceM'), 'durationS': r.get('durationS'), 'sep_m': m.get('sep_m'), 'crossings': m.get('crossings')}
        if c.get('golden'):
            ways = dict((x[0], x[1]) for x in m.get('ways', []))
            need = sum(x[1] for x in c.get('must_use', []))
            got = sum(min(ways.get(k, 0), v) for k, v in c.get('must_use', []))
            bad = sum(ways.get(k, 0) for k, _ in c.get('must_avoid', []))
            why = []
            if need and got < 0.7 * need:
                why.append(f'uses {got:.0f} of {need:.0f} m of the right ways')
            if bad > 15:
                why.append(f'{bad:.0f} m on ways the wrong walk took')
            if c.get('door'):
                d = r.get('door')
                if not d or dist((d['lat'], d['lon']), c['door']) > 5:
                    why.append('another door')
            ok = not why
            rec['golden'] = ok
            for key in [('all',), ('category', w['category']), ('city', w['city']), ('profile', w['profile']), ('issue', c.get('issue'))]:
                g = groups[key]
                g[0] += ok
                g[1] += 1
            if not ok:
                fails.append({'id': w['id'], 'category': w['category'], 'issue': c.get('issue'), 'why': why, 'check': c.get('reason')})
        per.append(rec)
    res = {'engine': args.engine, 'time': args.time, 'totals': dict(tot), 'golden': {' '.join(map(str, k)): f'{v[0]}/{v[1]}' for k, v in sorted(groups.items(), key=lambda x: (len(x[0]), x[0]))}, 'failures': fails, 'walks': per}
    g = groups[('all',)]
    print(f"golden walks passed: {g[0]} of {g[1]}")
    for k, v in sorted(groups.items(), key=lambda x: (len(x[0]), x[0])):
        if len(k) > 1:
            print(f"  {k[0]:8} {str(k[1]):12} {v[0]}/{v[1]}")
    t = tot
    print(f"all {t['walks']} walks: {t['sep_m']:.0f} m on carriageways with sidewalks drawn apart ({t['walks_sep']} walks), {t['busy_m']:.0f} m on busy carriageways, {t['car_m']:.0f} m car-only, "
          f"{t['crossings']} busy roads walked over without a crossing ({t['walks_cross']} walks), {t['blocked']} crossing=no, {t['closed_m']} m closed; "
          f"{t['distance_m']} m, {t['duration_s']} s, {t['turns']} turns; {t['errors']} errors")
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(res, f, indent=1, ensure_ascii=False)


if __name__ == '__main__':
    main()
