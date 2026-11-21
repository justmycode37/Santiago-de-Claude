"""Group per-frame detections into vehicle passes ("events") and render labelling sheets.

A pass is the largest vehicle followed through consecutive frames (box overlap). For each pass the frame
where the vehicle is biggest is cropped to the upper part of the vehicle (where destination displays are)
and tiled into numbered sheets for a person to read and label. Sheets show pixels only, never OCR output,
so labels are not biased by the recogniser being evaluated.

Usage: python -I make_events.py OCR_JSON [OCR_JSON...] --frames DIR --out DIR
Writes OUT/events.json and OUT/sheet-NN.jpg.
"""
import argparse, json, os

import cv2
import numpy as np


def iou(a, b):
    ax1, ay1, bx1, by1 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0, min(ax1, bx1) - max(a[0], b[0])), max(0, min(ay1, by1) - max(a[1], b[1]))
    inter = iw * ih
    return inter / max(1e-9, a[2] * a[3] + b[2] * b[3] - inter)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ocr", nargs="+")
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-sheet", type=int, default=6)
    ap.add_argument("--min-frames", type=int, default=2, help="only passes seen in at least this many frames get a sheet")
    args = ap.parse_args()
    frames = []
    for path in args.ocr:
        frames += json.load(open(path, encoding="utf-8"))["frames"]
    frames.sort(key=lambda f: f["image"])
    events, current, previous = [], None, None
    for f in frames:
        video, index = f["image"].split("/")[0], int(os.path.splitext(f["image"].split("/")[-1])[0])
        vehicle = max(f["vehicles"], key=lambda v: v["box"][3], default=None)
        same = (current is not None and vehicle is not None and previous is not None and previous[0] == video
                and index - previous[1] <= 2 and iou(previous[2], vehicle["box"]) >= 0.2)
        if vehicle is None:
            current = None
        elif same:
            current["frames"].append(f["image"])
        else:
            current = {"id": len(events), "video": video, "frames": [f["image"]]}
            events.append(current)
        if vehicle is not None:
            previous = (video, index, vehicle["box"])
            if current is not None and vehicle["box"][3] >= current.get("bestHeight", 0):
                current["bestHeight"], current["best"], current["bestBox"] = vehicle["box"][3], f["image"], vehicle["box"]
    os.makedirs(args.out, exist_ok=True)
    json.dump({"events": events}, open(os.path.join(args.out, "events.json"), "w", encoding="utf-8"), indent=1)
    tile_w, tile_h = 640, 250
    boxes = {}
    for f in frames:
        vehicle = max(f["vehicles"], key=lambda v: v["box"][3], default=None)
        if vehicle is not None:
            boxes[f["image"]] = vehicle["box"]

    def crop(image_name):
        img = cv2.imread(os.path.join(args.frames, image_name))
        H, W = img.shape[:2]
        x, y, w, h = boxes[image_name]
        x0, y0 = int(max(0, x - 0.02) * W), int(max(0, y - 0.03) * H)
        x1, y1 = int(min(1, x + w + 0.02) * W), int(min(1, y + h * 0.55) * H)
        c = img[y0:y1, x0:x1]
        scale = min(tile_w / c.shape[1], (tile_h - 24) / c.shape[0])
        return cv2.resize(c, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)

    labelled = [e for e in events if len(e["frames"]) >= args.min_frames]
    for start in range(0, len(labelled), args.per_sheet):
        chunk = labelled[start:start + args.per_sheet]
        sheet = np.full((tile_h * len(chunk), tile_w * 2, 3), 40, np.uint8)
        for k, e in enumerate(chunk):
            views = [e["frames"][0], e["frames"][len(e["frames"]) // 2] if e["best"] == e["frames"][0] else e["best"]]
            for j, name in enumerate(views):
                c = crop(name)
                ty, tx = k * tile_h, j * tile_w
                sheet[ty + 24:ty + 24 + c.shape[0], tx:tx + c.shape[1]] = c
            cv2.putText(sheet, f"#{e['id']}  ({len(e['frames'])} frames)", (6, k * tile_h + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        cv2.imwrite(os.path.join(args.out, f"sheet-{start // args.per_sheet:02d}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(len(events), "events")


if __name__ == "__main__":
    main()
