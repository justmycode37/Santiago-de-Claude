#!/usr/bin/env python3
"""Does the engine find the fastest journey? Random trips across the country, each checked two ways:

- against SBB's planner (transport.opendata.ch, about 1000 questions a day): where SBB gets there more than a few
  minutes before every journey the engine offers, the engine missed something — or walks or changes differently;
- against itself: leaving later can never get you there earlier, so a question asked 2, 5 and 9 hours later that
  finds an earlier arrival shows a journey the first answer missed (no second planner needed). Of the journeys
  within the maximum walk: one with a longer walk is offered or not by what leaves around it.

  fastest.py sample  --gtfs data/raw/gtfs/gtfs.zip --engine http://127.0.0.1:8080 --trips 400 --out trips.json
  fastest.py rerun   --in trips.json --engine http://127.0.0.1:8081 --out trips-b.json   # SBB's answers are kept
  fastest.py report  --in trips-b.json [--min 5] [--legs]
  fastest.py later   --in trips.json --engine http://127.0.0.1:8081

`sample` picks stations of the feed (any two, one of them a large station, or two within 60 km), on the days of
`--days` (give a weekday, a Saturday and a Sunday inside the feed's validity: the default ones are of November
2026), at hours from 05:00 to 23:00, and asks both planners; `--points` asks from and to a point 50–600 m beside
each station instead (as the app does: a place to a pin). `--set key=value` sets a routing option
(`--set maxWalkMin=40`). Every trip is written as it is answered, so a run can be stopped and taken up again; a
question a planner fails to answer is left out.
"""
import argparse, csv, datetime, io, json, math, os, random, sys, time, urllib.error, urllib.parse, urllib.request, zipfile, zoneinfo
from concurrent.futures import ThreadPoolExecutor

ZURICH = zoneinfo.ZoneInfo('Europe/Zurich')
SBB = 'https://transport.opendata.ch/v1/connections'
# the app's routing options (src/settings.ts DEFAULTS, as src/engine-journey.ts sends them)
OPTIONS = {'walkSpeed': 1.306, 'stairs': 'ok', 'escalators': True, 'wheelchair': False, 'hills': 'normal', 'flatterChanges': True,
           'transferMarginS': 0, 'maxWalkMin': 20}
HUBS = {'Zürich HB', 'Bern', 'Basel SBB', 'Lausanne', 'Genève', 'Luzern', 'St. Gallen', 'Lugano', 'Chur', 'Sion', 'Biel/Bienne', 'Winterthur',
        'Olten', 'Neuchâtel', 'Fribourg/Freiburg', 'Bellinzona', 'Thun', 'Interlaken Ost', 'Visp', 'Locarno'}


def http(url, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'content-type': 'application/json', 'user-agent': 'kante-fastest'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def hm(t):
    return datetime.datetime.fromtimestamp(t, ZURICH).strftime('%a %H:%M')


def unix(when):
    return int(datetime.datetime.fromisoformat(when).replace(tzinfo=ZURICH).timestamp())


def km(a, b):
    return math.hypot((a['lat'] - b['lat']) * 111.2, (a['lon'] - b['lon']) * 76.0)


def stations(gtfs):
    """The Swiss stations of the feed: the engine's id, SBB's (the DiDok number), name and position."""
    out = []
    with zipfile.ZipFile(gtfs) as z:
        for row in csv.DictReader(io.TextIOWrapper(z.open('stops.txt'), encoding='utf-8-sig')):
            if row['location_type'] != '1' or not row['didok'].isdigit():
                continue
            d, lat, lon = int(row['didok']), float(row['stop_lat']), float(row['stop_lon'])
            if 8500000 <= d < 8600000 and 45.8 < lat < 47.85 and 5.9 < lon < 10.5:
                out.append({'kid': 'st:' + row['stop_id'], 'hid': str(d), 'name': row['stop_name'], 'lat': lat, 'lon': lon})
    return out


def ref(q, end):
    e = q[end]
    return {'lat': e['lat'], 'lon': e['lon']} if q.get('points') else {'id': e['kid']}


def ask_engine(engine, q, options, at=None):
    """The engine's journeys for trip `q` (leaving at `at`, else at its own time), each with its rides and walks."""
    t0 = time.time()
    try:
        d = http(engine + '/api/plan', {'from': ref(q, 'from'), 'to': ref(q, 'to'), 'time': at or unix(q['when']), 'options': options})
    except urllib.error.HTTPError as e:
        if e.code != 400:  # the engine failing is not "no journey"
            raise
        return {'js': [], 'err': e.read().decode()[:200]}  # no route, no stop within walking distance
    js = []
    for j in d['journeys']:
        legs = []
        for l in j['legs']:
            if l['type'] == 'ride':
                legs.append(f"{l['line'].get('name')} {l['from']['quay']['stationName']} {hm(l['from']['dep'])} > {l['to']['quay']['stationName']} {hm(l['to']['arr'])}")
            elif l['durationS'] >= 60:
                legs.append(f"  walk ({l['kind']}) {l['durationS'] / 60:.1f} min, {l['distanceM']} m")
        js.append({'dep': j['dep'], 'arr': j['arr'], 'tr': j['transfers'], 'legs': legs, 'alerts': [a['text'] for a in j.get('alerts', [])],
                   'long': any(a['kind'] == 'long-walk' for a in j.get('alerts', []))})
    return {'js': js, 'ms': d.get('tookMs'), 'wall': time.time() - t0}


def ask_sbb(q):
    w = datetime.datetime.fromisoformat(q['when'])
    end = lambda e: f"{e['lat']:.6f},{e['lon']:.6f}" if q.get('points') else e['hid']
    d = http(SBB + '?' + urllib.parse.urlencode({'from': end(q['from']), 'to': end(q['to']), 'date': w.strftime('%Y-%m-%d'), 'time': w.strftime('%H:%M'), 'limit': 6}))
    js = []
    for c in d.get('connections', []):
        rides = [s for s in c['sections'] if s.get('journey')]
        js.append({'dep': c['from']['departureTimestamp'], 'arr': c['to']['arrivalTimestamp'], 'tr': len(rides) - 1, 'legs': [
            f"{s['journey']['category']}{s['journey']['number']} {s['departure']['station']['name']} {hm(s['departure']['departureTimestamp'])} > "
            f"{s['arrival']['station']['name']} {hm(s['arrival']['arrivalTimestamp'])}" for s in rides]})
    return {'js': js}


def options_of(args):
    o = dict(OPTIONS)
    for kv in args.set or []:
        k, v = kv.split('=', 1)
        o[k] = json.loads(v)
    return o


def first(side, not_before=0):
    """The journey of an answer that arrives first, of those leaving at or after `not_before`."""
    return min((j for j in side.get('js', []) if j['dep'] >= not_before), key=lambda j: j['arr'], default=None)


def first_arrival(side, not_before=0):
    j = first(side, not_before)
    return j and j['arr']


def save(res, path):
    tmp = path + '.tmp'
    json.dump(res, open(tmp, 'w'), ensure_ascii=False)
    os.replace(tmp, path)


def cmd_sample(args):
    st, rnd, options = stations(args.gtfs), random.Random(args.seed), options_of(args)
    hubs = [s for s in st if s['name'] in HUBS]
    days = args.days.split(',')
    res = json.load(open(args.out)) if os.path.exists(args.out) else []
    # A run taken up again draws the same questions again and skips those already asked: each trip keeps the number
    # of its draw (a question that failed is not asked again).
    asked = max((q.get('draw', i + 1) for i, q in enumerate(res)), default=0)
    draw = 0
    while len(res) < args.trips:
        kind = rnd.choice(['any', 'any', 'hub', 'near'])
        a = rnd.choice(st)
        if kind == 'any':
            b = rnd.choice(st)
        elif kind == 'hub':
            b = rnd.choice(hubs)
            if rnd.random() < .5:
                a, b = b, a
        else:
            b = rnd.choice([s for s in st if 3 < km(a, s) < 60])
        when = f"{rnd.choice(days)}T{rnd.choice([5, 6, 7, 8, 9, 11, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23]):02d}:{rnd.choice([0, 10, 20, 30, 40, 50]):02d}"
        q = {'kind': kind, 'from': a, 'to': b, 'when': when, 'km': round(km(a, b), 1)}
        if args.points:
            def beside(e):
                r, th = rnd.uniform(50, 600), rnd.uniform(0, 2 * math.pi)
                return {**e, 'lat': e['lat'] + r * math.cos(th) / 111200, 'lon': e['lon'] + r * math.sin(th) / 76000, 'name': 'near ' + e['name']}
            q['from'], q['to'], q['points'] = beside(a), beside(b), True
        if km(a, b) < 2:
            continue
        draw += 1
        if draw <= asked:
            continue
        q['draw'] = draw
        try:
            q['k'], q['s'] = ask_engine(args.engine, q, options), ask_sbb(q)
        except Exception as e:  # SBB's planner is slow at times: wait and ask the next one
            print(f"failed, left out: {q['from']['name']} -> {q['to']['name']} {when}: {e}", file=sys.stderr)
            time.sleep(5)
            continue
        res.append(q)
        save(res, args.out)
        ka, sa = first_arrival(q['k']), first_arrival(q['s'], unix(when) - 60)
        print(len(res), q['from']['name'], '->', q['to']['name'], when, '| engine', ka and hm(ka), '| SBB', sa and hm(sa), '' if not (ka and sa) else f'{round((ka - sa) / 60):+d} min', flush=True)
        time.sleep(1)


def cmd_rerun(args):
    options = options_of(args)
    res = json.load(open(args.inp))
    with ThreadPoolExecutor(4) as ex:
        res = list(ex.map(lambda q: {**q, 'k': ask_engine(args.engine, q, options)}, res))
    save(res, args.out)
    ms = sorted(q['k'].get('ms') or 0 for q in res)
    print(f"{len(res)} trips; the engine's own time: median {ms[len(ms) // 2]:.0f} ms, 90 % under {ms[int(len(ms) * .9)]:.0f} ms, longest {ms[-1]:.0f} ms")
    cmd_report(argparse.Namespace(inp=args.out, min=5, legs=False))


def cmd_report(args):
    res = json.load(open(args.inp))
    later, earlier, none_k, none_s, neither, compared = [], 0, [], 0, 0, 0
    for q in res:
        ka, sa = first_arrival(q['k']), first_arrival(q['s'], unix(q['when']) - 60)
        if ka is None and sa is None:
            neither += 1
        elif ka is None:
            none_k.append(q)
        elif sa is None:
            none_s += 1
        else:
            compared += 1
            d = (ka - sa) / 60
            if d > args.min:
                later.append((d, q))
            earlier += d < -args.min
    print(f"{len(res)} trips, {compared} answered by both: the engine arrives more than {args.min} min after SBB in {len(later)}, more than {args.min} min before it in "
          f"{earlier}; no journey from the engine where SBB has one: {len(none_k)}; none from SBB: {none_s}; from neither: {neither}")
    for d, q in [(None, q) for q in none_k] + sorted(later, key=lambda r: -r[0]):
        print(f"\n{'no journey' if d is None else f'{d:+.0f} min'}  {q['from']['name']} -> {q['to']['name']}  {q['when']}  ({q['km']} km)")
        if not args.legs:
            continue
        for name, side, not_before in (('engine', q['k'], 0), ('SBB', q['s'], unix(q['when']) - 60)):
            best = first(side, not_before)
            print(f"  {name}: " + (f"{hm(best['dep'])} -> {hm(best['arr'])}, {best['tr']} changes" if best else side.get('err', 'none')))
            for l in (best or {}).get('legs', []):
                print('      ' + l)


def cmd_later(args):
    options = options_of(args)
    res = json.load(open(args.inp))

    # (a journey with a walk beyond the maximum is left out on both sides: whether it is offered depends on the
    # journeys leaving around it, so a later question may rightly offer one the first did not)
    within = lambda side: {'js': [j for j in side['js'] if not j.get('long')]}

    def one(q):
        t = unix(q['when'])
        asked = ask_engine(args.engine, q, options)
        arr0 = first_arrival(within(asked))
        if arr0 is None and asked['js']:
            return None  # only journeys with a longer walk: those within it are on the later pages
        for dh in (2, 5, 9):
            b = first(within(ask_engine(args.engine, q, options, at=t + dh * 3600)))
            if b and (arr0 is None or b['arr'] < arr0 - 60):
                return q, arr0, dh, b
        return None

    with ThreadPoolExecutor(4) as ex:
        bad = [r for r in ex.map(one, res) if r]
    for q, arr0, dh, b in bad:
        print(f"{q['from']['name']} -> {q['to']['name']} {q['when']}: first arrival {arr0 and hm(arr0)}; asked {dh} h later: {hm(b['dep'])} -> {hm(b['arr'])}")
    print(f"{len(bad)} of {len(res)} trips: a later question found an earlier arrival")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sample')
    s.add_argument('--gtfs', required=True)
    s.add_argument('--trips', type=int, default=200)
    s.add_argument('--seed', type=int, default=1)
    s.add_argument('--days', default='2026-11-25,2026-11-25,2026-11-26,2026-11-28,2026-11-29', help='the days to ask for, comma-separated (a day named twice is asked twice as often)')
    s.add_argument('--points', action='store_true')
    r = sub.add_parser('rerun')
    p = sub.add_parser('report')
    p.add_argument('--min', type=int, default=5)
    p.add_argument('--legs', action='store_true')
    l = sub.add_parser('later')
    for x in (s, r, l):
        x.add_argument('--engine', required=True)
        x.add_argument('--set', action='append')
    for x in (r, p, l):
        x.add_argument('--in', dest='inp', required=True)
    for x in (s, r):
        x.add_argument('--out', required=True)
    args = ap.parse_args()
    sys.exit({'sample': cmd_sample, 'rerun': cmd_rerun, 'report': cmd_report, 'later': cmd_later}[args.cmd](args) or 0)


if __name__ == '__main__':
    main()
