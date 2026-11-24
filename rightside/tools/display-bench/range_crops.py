"""Reading-range pilot, stages B and C (docs/ar-recognition-plan.md step 3; docs/ar-reading-range.md).

B. Which vehicle is which: a simple IoU tracker links range_detect.py's boxes frame to frame. A labelled pass of the
   1 frame/s bench (data/bern-video-events.json + labels) is tied to the track whose box overlaps the pass's vehicle
   (IoU >= 0.5) in every one of its labelled frames; a pass that falls on two tracks is left out ("unknown"). The
   track's frames before the first labelled one (the far approach) keep the label only because the tracker
   followed the same vehicle there: spot-check the crops before trusting a far result.
C. What there is to read: for every frame of a tied track, the upper band of the vehicle (55 % of its height, 4 %
   wider) at the video's own resolution, and two 3-frame variants of it, aligned to the newest frame (scaled by the
   boxes, then shifted by phase correlation): the sharpest of the three by contrast, and their pixel-wise maximum.
   The display's glyph height in pixels comes from the pass's nearest frame (the text line there that reads as the
   labelled line or destination, as a share of the vehicle's height; never an advert) times the vehicle's height in
   each frame, so a frame nothing was read in still counts at its size. A pass with no such line in its nearest view,
   or whose track another labelled pass also falls on (the tracker joined two vehicles), is left out.
   The bench's own front end (ocr_frames.py: PP-OCRv5 det + rec, the crop enlarged to 1600 px, at most twice) reads
   every crop; the web's (src/ppocr.ts) reads them in range_eval.mts.

    python -I range_crops.py --bench DIR --video VIDEO --detections det5.jsonl --frames FRAMES/VIDEO --models DIR --out OUT [--fps 5]
"""
import argparse, difflib, importlib.util, json, os, sys, unicodedata

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def iou(a, b):
    ax1, ay1, bx1, by1 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0, min(ax1, bx1) - max(a[0], b[0])), max(0, min(ay1, by1) - max(a[1], b[1]))
    inter = iw * ih
    return inter / max(1e-9, a[2] * a[3] + b[2] * b[3] - inter)


def track(frames):
    """frames: [(n, [box…])] in order -> {track id: [(n, box)]}; greedy IoU >= 0.3, a gap of one frame bridged; a box
    whose height jumps by more than 35 % from the last one is another vehicle (one replacing another in the same spot)."""
    tracks, live, nid = {}, [], 0
    for n, boxes in frames:
        live = [(tid, last_n, last_box) for tid, last_n, last_box in live if n - last_n <= 2]
        pairs = sorted(((iou(lb, b), i, j) for i, (_, _, lb) in enumerate(live) for j, b in enumerate(boxes)), reverse=True)
        used_t, used_b, nxt = set(), set(), []
        for v, i, j in pairs:
            if v < 0.3 or i in used_t or j in used_b:
                continue
            ratio = boxes[j][3] / max(1e-6, live[i][2][3])
            if ratio > 1.35 or ratio < 1 / 1.35:
                continue
            used_t.add(i); used_b.add(j)
            tid = live[i][0]
            tracks[tid].append((n, boxes[j]))
            nxt.append((tid, n, boxes[j]))
        for i, l in enumerate(live):
            if i not in used_t:
                nxt.append(l)
        for j, b in enumerate(boxes):
            if j not in used_b:
                tracks[nid] = [(n, b)]
                nxt.append((nid, n, b))
                nid += 1
        live = nxt
    return tracks


def band(box, W, H):
    x, y, w, h = box
    x0, x1 = max(0, x - 0.04 * w), min(1, x + 1.04 * w)
    y0, y1 = max(0, y), min(1, y + 0.55 * h)
    return int(x0 * W), int(y0 * H), max(1, int(x1 * W) - int(x0 * W)), max(1, int(y1 * H) - int(y0 * H))


def align(prev, cur):
    """prev resized to cur's size and shifted onto it by phase correlation (grey levels)."""
    p = cv2.resize(prev, (cur.shape[1], cur.shape[0]), interpolation=cv2.INTER_LINEAR)
    g1, g2 = cv2.cvtColor(p, cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.cvtColor(cur, cv2.COLOR_BGR2GRAY).astype(np.float32)
    (dx, dy), _ = cv2.phaseCorrelate(g1, g2)
    m = np.array([[1, 0, dx], [0, 1, dy]], dtype=np.float32)
    return cv2.warpAffine(p, m, (cur.shape[1], cur.shape[0]), borderMode=cv2.BORDER_REPLICATE)


def fold(s):
    s = unicodedata.normalize("NFKD", s.replace("ß", "ss")).encode("ascii", "ignore").decode().lower()
    return "".join(c for c in s if c.isalnum())


def names_display(text, line, destination):
    """Does this OCR text read as the labelled line or (part of) the destination? (sizing only, never a decision)"""
    t = fold(text)
    if not t:
        return False
    if t == fold(line) or t.startswith(fold(line)) and len(t) > len(fold(line)) + 2:
        return True
    parts = [fold(destination)] + [fold(x) for x in destination.split(",")] + [fold(w) for w in destination.replace(",", " ").split() if len(w) >= 4]
    return any(len(t) >= 3 and difflib.SequenceMatcher(None, t, p).ratio() >= 0.7 for p in parts if p)


def contrast(img):
    return float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).std())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", required=True, help="data dir of the 1 frame/s bench (events, labels, ocr)")
    ap.add_argument("--video", required=True)
    ap.add_argument("--detections", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=5)
    a = ap.parse_args()
    spec = importlib.util.spec_from_file_location("ocr_frames", os.path.join(HERE, "ocr_frames.py"))
    assert spec and spec.loader
    of = importlib.util.module_from_spec(spec)
    sys.modules["ocr_frames"] = of
    spec.loader.exec_module(of)
    det, rec = of.TextDetector(os.path.join(a.models, "det.onnx")), of.TextRecognizer(os.path.join(a.models, "rec.onnx"))

    load = lambda f: json.load(open(os.path.join(a.bench, f), encoding="utf-8"))
    events = {e["id"]: e for e in load("bern-video-events.json")["events"]}
    labels = [l for l in load("bern-video-labels.json")["labels"] if l["line"] != "-"]
    ocr1 = {f["image"]: f for f in load("bern-video-ocr.json")["frames"]}
    dets = [json.loads(l) for l in open(a.detections, encoding="utf-8") if l.strip()]
    dets = [d for d in dets if d["image"].startswith(a.video + "/")]
    H, W = dets[0]["height"], dets[0]["width"]
    num = lambda name: int(os.path.splitext(name.split("/")[-1])[0])
    frames5 = {num(d["image"]): d for d in dets}
    tracks = track([(n, [v["box"] for v in frames5[n]["vehicles"]]) for n in sorted(frames5)])
    at = {(n, tuple(b)): tid for tid, pts in tracks.items() for n, b in pts}

    os.makedirs(os.path.join(a.out, "crops"), exist_ok=True)
    meta, skipped = [], []
    sized = []  # how each pass's glyphs were sized (to audit)
    tied = {}  # labelled pass -> (track, nearest view) when it falls on exactly one track
    for lab in labels:
        e = events.get(lab["event"])
        if not e or not e["frames"][0].startswith(a.video + "/"):
            continue
        tids, near = set(), None
        for name in e["frames"]:
            f1 = ocr1.get(name)
            if not f1 or not f1["vehicles"]:
                continue
            v1 = max(f1["vehicles"], key=lambda v: v["box"][3])
            m = int(round((num(name) - 1) * a.fps)) + 1  # same moment at a fps frames/s
            best = max(((iou(v1["box"], b), (m, tuple(b))) for b in [v["box"] for v in frames5.get(m, {"vehicles": []})["vehicles"]]), default=(0, None))
            if best[0] >= 0.5:
                tids.add(at[best[1]])
            if near is None or v1["box"][3] > near["box"][3]:
                near = v1
        if len(tids) != 1 or near is None:
            skipped.append({"event": lab["event"], "why": "tracks: %d" % len(tids)})
            continue
        tied[lab["event"]] = (tids.pop(), near, lab)
    claimed = {}
    for ev, (tid, _, _) in tied.items():
        claimed.setdefault(tid, []).append(ev)
    for ev, (tid, near, lab) in sorted(tied.items()):
        if len(claimed[tid]) > 1:
            skipped.append({"event": ev, "why": f"its track also carries passes {claimed[tid]}"})
            continue
        pts = tracks[tid]
        crops, rows_out = [], []
        for n, box in pts:
            img = cv2.imread(os.path.join(a.frames, "%05d.jpg" % n))
            bx, by, bw, bh = band(box, W, H)
            crop = img[by:by + bh, bx:bx + bw]
            crops.append((n, box, crop, (bx, by, bw, bh)))
        for k, (n, box, crop, r) in enumerate(crops):
            base = f"{lab['event']:03d}_{n:05d}"
            cv2.imwrite(os.path.join(a.out, "crops", base + ".png"), crop)
            row = {"event": lab["event"], "frame": n, "t": (n - 1) / a.fps, "line": lab["line"], "destination": lab["destination"],
                   "box": box, "glyphPx": None, "crop": base + ".png", "region": r}
            if k >= 2:
                three = [align(crops[k - 2][2], crop), align(crops[k - 1][2], crop), crop]
                best = max(three, key=contrast)
                cv2.imwrite(os.path.join(a.out, "crops", base + "_best.png"), best)
                cv2.imwrite(os.path.join(a.out, "crops", base + "_max.png"), np.maximum(np.maximum(three[0], three[1]), three[2]))
                row["best"], row["max"] = base + "_best.png", base + "_max.png"
            # the bench's own front end on the same crop (texts in crop-relative boxes)
            texts = of.read_region(crop, [0, 0, 1, 1], det, rec)
            row["bench"] = texts
            rows_out.append(row)
        # glyph height share: the median, over this track's frames whose vehicle is whole in the picture (its box
        # touches no edge) and whose bench read has a line reading as the labelled display, of that line's height as a
        # share of the vehicle's; else from the nearest 1 frame/s view
        shares, by = [], []
        for row in rows_out:
            bx, byy, bw, bh = row["box"]
            if bx < 0.005 or byy < 0.005 or bx + bw > 0.995 or byy + bh > 0.995:
                continue
            hits = [(t["box"][3] * row["region"][3], t["text"]) for t in row["bench"] if names_display(t["text"], lab["line"], lab["destination"])]
            if hits:
                hpx, text = max(hits)
                shares.append(hpx / (bh * H)); by.append(text)
        # only from this track's own reads: a share from the 1 frame/s view (another detector's box) proved unreliable
        share = sorted(shares)[len(shares) // 2] if shares else None
        if share is None:
            skipped.append({"event": ev, "why": "the display was never read in this pass, so its glyphs cannot be sized"})
            continue
        for row in rows_out:
            row["glyphPx"] = round(share * row["box"][3] * H, 1)
        meta += rows_out
        sized.append({"event": ev, "share": round(share, 4), "from": len(shares), "texts": sorted(set(by))[:6]})
        print(f"event {lab['event']} ({lab['line']} {lab['destination']}): {len(crops)} frames, glyph share {share:.3f} from {len(shares)} reads {sorted(set(by))[:4]}", file=sys.stderr, flush=True)
    json.dump({"video": a.video, "fps": a.fps, "frames": meta, "skipped": skipped, "sized": sized}, open(os.path.join(a.out, "range.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{len(meta)} frames, {len(skipped)} passes left out", file=sys.stderr)


if __name__ == "__main__":
    main()
