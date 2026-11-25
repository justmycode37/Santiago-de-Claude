#!/usr/bin/env python3
"""Dev helper: POST /api/plan and print the journeys readably.
usage: plan.py FROM TO [YYYY-MM-DDTHH:MM] [key=value ...]   FROM/TO = station id 'st:…', 'lat,lon', or a search string
options: speed=1.3 stairs=ok|avoid|never wheelchair=1 margin=120 arrive=1 host=http://localhost:8080 steps=1 raw=1
"""
import json, sys, urllib.request, urllib.parse, datetime, zoneinfo
Z = zoneinfo.ZoneInfo("Europe/Zurich")
args = [a for a in sys.argv[1:] if "=" not in a or a.startswith("st:")]
kv = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a and not a.startswith("st:"))
host = kv.get("host", "http://localhost:8080")
def get(path):
    return json.load(urllib.request.urlopen(host + path))
def place(s):
    if s.startswith("st:"): return {"id": s}
    try:
        lat, lon = map(float, s.split(","))
        return {"lat": lat, "lon": lon}
    except ValueError:
        r = get("/api/search?q=" + urllib.parse.quote(s))["results"][0]
        return {"id": r["id"], "lat": r["lat"], "lon": r["lon"], "name": r["name"]}
def hm(t): return datetime.datetime.fromtimestamp(t, Z).strftime("%H:%M:%S")
req = {"from": place(args[0]), "to": place(args[1]), "options": {
    "walkSpeed": float(kv.get("speed", 1.3)), "stairs": kv.get("stairs", "ok"), "escalators": kv.get("escalators", "1") == "1",
    "wheelchair": kv.get("wheelchair", "0") == "1", "transferMarginS": int(kv.get("margin", 0)), "maxWalkMin": float(kv.get("maxwalk", 20))}}
if len(args) > 2:
    req["time"] = int(datetime.datetime.fromisoformat(args[2]).replace(tzinfo=Z).timestamp())
if kv.get("arrive") == "1": req["arriveBy"] = True
if "onboard" in kv:
    tid, date = kv["onboard"].rsplit("@", 1); req["onboard"] = {"tripId": tid, "serviceDate": date}; req.pop("from")
r = urllib.request.Request(host + "/api/plan", json.dumps(req).encode(), {"Content-Type": "application/json"})
try:
    res = json.load(urllib.request.urlopen(r))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()); sys.exit(1)
if kv.get("raw") == "1": print(json.dumps(res, indent=1, ensure_ascii=False)); sys.exit()
print(f"{res['from']['name']} -> {res['to']['name']}   {len(res['journeys'])} journeys in {res['tookMs']:.1f} ms  realtime={res['realtime']}")
def show(j):
    print(f"\n{hm(j['dep'])} -> {hm(j['arr'])}  {j['durationS']//60} min  {j['transfers']} changes  walk {j['walkS']//60} min / {j['walkM']} m")
    for l in j["legs"]:
        if l["type"] == "walk":
            extra = "".join(f" {k}={l[k]}" for k in ("stairsUp", "stairsDown", "lifts", "escalators") if l[k])
            print(f"   walk[{l['kind']}] {hm(l['dep'])}-{hm(l['arr'])} {l['durationS']}s {l['distanceM']}m{extra} slack={l.get('slackS')} off={l.get('officialMinS')} {'APPROX' if l.get('approximate') else ''} {l['from']['name']} -> {l['to']['name']}")
            if kv.get("steps") == "1":
                for s in l["steps"]: print(f"        - {s['text']}  ({s['distM']} m, {s['durS']} s)")
        else:
            f, t = l["from"], l["to"]; q = f["quay"]
            side = (q.get("side") or {}).get("text", "")
            print(f"   {l['line']['category']} {l['line']['name']} -> {l['headsign']}  {hm(f['dep'])}{'%+d' % f['depDelayS'] if f.get('depDelayS') else ''} {q['stationName']} [{q['noun']} {q['label']}{q.get('sectors') or ''} L{q.get('level')} {q['precision']}] {side} towards {l.get('towards')} => {hm(t['arr'])} {t['quay']['stationName']} [{t['quay']['label']}] {len(l['intermediate'])} stops {l['live']}{' STAY' if l.get('stayOnBoard') else ''}{' ONBOARD' if l.get('onboard') else ''}")
    for a in j.get("alerts", []): print(f"   ! {a['severity']}: {a['text']}")
for j in res["journeys"]: show(j)
if res.get("walkOnly"): print("\nWALK ONLY:"); show(res["walkOnly"])
