"""Poll the live map exactly like the page does (every 10 s) and keep every snapshot."""
import gzip, json, sys, time, urllib.request

out, minutes = sys.argv[1], float(sys.argv[2])
BASE = "http://127.0.0.1:8090"
shapes, epoch = {}, None
start = time.time()
n = 0
with gzip.open(out, "wt", encoding="utf-8") as f:
    while time.time() - start < minutes * 60:
        due = start + n * 10
        time.sleep(max(0, due - time.time()))
        try:
            req = urllib.request.Request(BASE + "/vehicles", headers={"accept-encoding": "gzip"})
            raw = urllib.request.urlopen(req, timeout=20).read()
            recv = time.time()
            d = json.loads(gzip.decompress(raw))
            if d["epoch"] != epoch:
                epoch, shapes = d["epoch"], {}
            need = sorted({r[15] for r in d["vehicles"] if r[15] and r[15] not in shapes})
            new = {}
            if need:
                r = urllib.request.urlopen(urllib.request.Request(BASE + "/shapes", data=json.dumps(need).encode(), method="POST"), timeout=20).read()
                new = json.loads(gzip.decompress(r))["shapes"]
                for k, v in new.items():
                    shapes[int(k)] = v
            f.write(json.dumps({"recv": recv, "t": d["t"], "epoch": d["epoch"], "feed": d["feedUpdatedAt"], "vehicles": d["vehicles"], "shapes": new}) + "\n")
            f.flush()
        except Exception as e:  # keep going; a gap is itself a finding
            f.write(json.dumps({"recv": time.time(), "error": str(e)}) + "\n")
        n += 1
print("polls", n)
