#!/usr/bin/env python3
"""Writes the checks into the reference set: for each walk, the verdict of the check by eye (render.py's pictures)
and, for a walk where one of the two walks shown was judged right with some confidence (a "golden" walk), what the
right walk must do: the OpenStreetMap ways it uses and the wrong one does not (`must_use`, metres), the ways only
the wrong one uses (`must_avoid`), and the door it ends at.

    python3 -I verdict.py --set refwalks.json --verdicts DIR/verdicts --walks DIR/img/walks.json --data DATA --bin compare
"""
import argparse, datetime, glob, json, subprocess

MIN_M = 15.0  # a way counts when the walk spends at least this on it


def ways_of(bin_, data, walks):
    lines = [json.dumps({'key': k, 'geometry': g}) for k, g in walks.items() if g]
    out = subprocess.run([bin_, 'metrics', data], input='\n'.join(lines) + '\n', capture_output=True, text=True, check=True).stdout
    return {m['key']: m for m in map(json.loads, out.splitlines())}


def main():
    ap = argparse.ArgumentParser()
    for k in ['set', 'verdicts', 'walks', 'data', 'bin']:
        ap.add_argument('--' + k, required=True)
    args = ap.parse_args()
    doc = json.load(open(args.set, encoding='utf-8'))
    V = {}
    for f in sorted(glob.glob(args.verdicts + '/verdicts-*.jsonl')):
        for line in open(f, encoding='utf-8'):
            line = line.strip()
            if line:
                v = json.loads(line)
                V[v['id']] = v
    ans = json.load(open(args.walks, encoding='utf-8'))
    geo = {}
    for wid, r in ans.items():
        for side in 'ab':
            geo[f'{wid}/{side}'] = (r[side] or {}).get('geometry')
    M = ways_of(args.bin, args.data, geo)
    today = datetime.date.today().isoformat()
    n_golden = 0
    for w in doc['walks']:
        v = V.get(w['id'])
        if not v:
            continue
        chk = {'verdict': v['verdict'], 'confidence': v.get('confidence'), 'issue': v.get('issue'), 'reason': v.get('reason'),
               'checked': today, 'how': 'by eye on SWISSIMAGE with the OpenStreetMap overlay (render.py), A = main, B = this change'}
        good = {'A': 'a', 'B': 'b'}.get(v['verdict'])
        if good and v.get('confidence') in ('high', 'medium'):
            bad = 'b' if good == 'a' else 'a'
            mg = dict((x[0], x[1]) for x in (M.get(f"{w['id']}/{good}") or {}).get('ways', []) if x[0] != 0)
            mb = dict((x[0], x[1]) for x in (M.get(f"{w['id']}/{bad}") or {}).get('ways', []) if x[0] != 0)
            chk['must_use'] = [[k, round(m)] for k, m in mg.items() if m >= MIN_M and mb.get(k, 0) < 0.3 * m]
            chk['must_avoid'] = [[k, round(m)] for k, m in mb.items() if m >= MIN_M and mg.get(k, 0) < 0.3 * m]
            door = (ans[w['id']][good] or {}).get('door')
            other = (ans[w['id']][bad] or {}).get('door')
            if door and (not other or (door['lat'], door['lon']) != (other['lat'], other['lon'])):
                chk['door'] = [door['lat'], door['lon']]
            chk['right_m'] = (ans[w['id']][good] or {}).get('distanceM')
            chk['golden'] = bool(chk['must_use'] or chk['must_avoid'] or chk.get('door'))
            n_golden += chk['golden']
        else:
            chk['golden'] = False
        w['check'] = chk
    with open(args.set, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print(f'{len(V)} verdicts, {n_golden} golden walks')


if __name__ == '__main__':
    main()
