#!/usr/bin/env python3
"""Choose the reference walks from mine.py's candidates: 150 walks in ten cities, by what the reference engine (A,
`main`) gets wrong, plus controls; about a third step-free. Written once and then kept (the set is frozen: the
walks, their ends and profile do not change when the engine does).

    python3 -I select.py --candidates DIR/candidates.json --out refwalks.json [--seed 5]

Categories (each walk in the first that fits, by A's walk):
- road:    A walks 30 m or more on carriageways whose sidewalks are drawn apart
- cross:   A walks over a busy road (tertiary and up) where no crossing is mapped, from a footway or sidewalk
- door:    A and B end at different doors
- zigzag:  A turns at 12 or more junctions per km
- control: any other
"""
import argparse, json, random
from collections import Counter

QUOTA = {'road': 45, 'cross': 30, 'door': 25, 'zigzag': 20, 'control': 30}


def category(w):
    a, b = w['a'].get('metrics') or {}, w['b'].get('metrics') or {}
    if a.get('sep_m', 0) >= 30:
        return 'road'
    if a.get('crossings', 0) >= 1:
        return 'cross'
    da, db = (w['a'].get('door') or {}), (w['b'].get('door') or {})
    if (da.get('lat'), da.get('lon')) != (db.get('lat'), db.get('lon')):
        return 'door'
    if a.get('len_m', 0) > 100 and a.get('turns', 0) * 1000 / a['len_m'] >= 12:
        return 'zigzag'
    return 'control'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--candidates', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--seed', type=int, default=5)
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    W = [w for w in json.load(open(args.candidates, encoding='utf-8')) if 'error' not in w['a'] and 'error' not in w['b'] and w['a'].get('geometry') and w['b'].get('geometry')]
    by = {}
    for i, w in enumerate(W):
        by.setdefault(category(w), []).append(i)
    chosen = []
    for cat, n in QUOTA.items():
        pool = by.get(cat, [])
        rnd.shuffle(pool)
        # round-robin over the cities, so that each has some of each category it has
        per_city = {}
        for i in pool:
            per_city.setdefault(W[i]['city'], []).append(i)
        picked = []
        while len(picked) < n and any(per_city.values()):
            for c in sorted(per_city):
                if per_city[c] and len(picked) < n:
                    picked.append(per_city[c].pop())
        chosen += [(cat, i) for i in picked]
    out = []
    for k, (cat, i) in enumerate(chosen):
        w = W[i]
        out.append({
            'id': f'{w["city"]}-{k + 1:03d}',
            'city': w['city'],
            'category': cat,
            'profile': w['profile'],
            'from': w['from'], 'from_name': w['from_name'],
            'to': w['to'], 'to_name': w['to_name'],
            # filled in by the check (verdict.py): which walk is right, the ways it must use and avoid, its door
            'check': None,
        })
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'data': 'OpenStreetMap Switzerland 2026-11-21 (switzerland-latest.osm.pbf), register 2026-11-24', 'walks': out}, f, indent=1, ensure_ascii=False)
    print(Counter(w['category'] for w in out), Counter(w['city'] for w in out), Counter(w['profile'] for w in out))


if __name__ == '__main__':
    main()
