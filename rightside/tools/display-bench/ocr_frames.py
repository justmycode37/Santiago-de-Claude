"""Recorded-image front end for the vehicle display benchmark (runs on a PC, not on the phone).

For every image: find buses/trams with the same zero-shot YOLOE prompts as the app's bundled
TransportSegmenter, then read text on each vehicle with PP-OCRv5 (mobile text detector + the latin
recogniser whose weights the app bundles as VehicleDisplayRecognizer). Writes one JSON per run with
normalised, top-left-origin boxes, the same convention as the app's VehicleText.

This is a stand-in for the phone: Apple Vision OCR (the app's primary reader) does not run on Windows,
and the PC YOLOE checkpoint is the PyTorch original, not the converted Core ML model. Use it to compare
matching strategies on the same OCR evidence, not as a measurement of on-device accuracy.

Usage:
  python -I ocr_frames.py --models DIR --images DIR --out ocr.json [--labels labels.json] [--no-detector]
DIR for --models must hold det.onnx (PP-OCRv5_mobile_det), rec.onnx (latin_PP-OCRv5_mobile_rec) and,
unless --no-detector, yoloe-11s-seg.pt. The character list is read from the app bundle.
"""
import argparse, json, math, os, sys, time

import cv2
import numpy as np
import onnxruntime as ort
import pyclipper

HERE = os.path.dirname(os.path.abspath(__file__))
CHARS = os.path.join(HERE, "..", "..", "redesign", "apps", "ios", "RightSide", "Resources",
                     "VehicleDisplayRecognition", "v1", "display-characters.json")
PROMPTS = ["city bus", "tramway", "train"]  # model-manifest.json textPrompts
KINDS = ["bus", "tram", "train"]


class TextDetector:
    def __init__(self, path):
        self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    def __call__(self, bgr, limit=960):
        h, w = bgr.shape[:2]
        scale = min(1.0, limit / max(h, w)) if max(h, w) > limit else limit / max(h, w) if max(h, w) < 320 else 1.0
        nh, nw = max(32, int(round(h * scale / 32)) * 32), max(32, int(round(w * scale / 32)) * 32)
        img = cv2.resize(bgr, (nw, nh)).astype(np.float32) / 255.0
        img = (img - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
        prob = self.session.run(None, {self.session.get_inputs()[0].name: img.transpose(2, 0, 1)[None].astype(np.float32)})[0][0, 0]
        mask = (prob > 0.3).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for c in contours[:1000]:
            if cv2.contourArea(c) < 6:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            score = float(prob[y:y + bh, x:x + bw][mask[y:y + bh, x:x + bw] > 0].mean())
            if score < 0.6:
                continue
            rect = cv2.minAreaRect(c)
            poly = cv2.boxPoints(rect)
            area, length = cv2.contourArea(poly), cv2.arcLength(poly, True)
            if length == 0:
                continue
            offset = pyclipper.PyclipperOffset()
            offset.AddPath([tuple(p) for p in poly.astype(np.int64)], pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
            grown = offset.Execute(area * 1.6 / length)
            if not grown:
                continue
            g = np.array(grown[0], dtype=np.float64)
            x0, y0 = float(g[:, 0].min()) / nw, float(g[:, 1].min()) / nh
            x1, y1 = float(g[:, 0].max()) / nw, float(g[:, 1].max()) / nh
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(1, x1), min(1, y1)
            if (y1 - y0) * h < 5 or (x1 - x0) * w < 5:
                continue
            boxes.append((x0, y0, x1, y1))
        return boxes


class TextRecognizer:
    def __init__(self, path):
        self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.chars = json.load(open(CHARS, encoding="utf-8"))

    def __call__(self, bgr):
        h, w = bgr.shape[:2]
        if h < 4 or w < 4:
            return "", 0.0
        nw = int(min(1600, max(16, math.ceil(48 * w / h))))
        img = cv2.resize(bgr, (nw, 48)).astype(np.float32) / 127.5 - 1.0
        width = max(320, nw)
        tensor = np.zeros((1, 3, 48, width), np.float32)
        tensor[0, :, :, :nw] = img.transpose(2, 0, 1)
        out = self.session.run(None, {self.session.get_inputs()[0].name: tensor})[0][0]
        idx, prob = out.argmax(1), out.max(1)
        text, scores, prev = "", [], -1
        for i, p in zip(idx, prob):
            if i != 0 and i != prev:
                text += self.chars[i] if i < len(self.chars) else ""
                scores.append(float(p))
            prev = i
        return text.strip(), (float(np.mean(scores)) if scores else 0.0)


def read_region(image, region, det, rec, upscale_to=1600):
    """OCR inside a normalised region; returns texts with boxes normalised to the full image."""
    H, W = image.shape[:2]
    x0, y0, x1, y1 = region
    px0, py0, px1, py1 = int(x0 * W), int(y0 * H), int(math.ceil(x1 * W)), int(math.ceil(y1 * H))
    crop = image[py0:py1, px0:px1]
    if crop.shape[0] < 16 or crop.shape[1] < 16:
        return []
    scale = min(2.0, upscale_to / crop.shape[1])
    if scale > 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    ch, cw = crop.shape[:2]
    out = []
    for bx0, by0, bx1, by1 in det(crop):
        piece = crop[int(by0 * ch):int(math.ceil(by1 * ch)), int(bx0 * cw):int(math.ceil(bx1 * cw))]
        text, score = rec(piece)
        if not text:
            continue
        gx0 = (px0 + bx0 * (px1 - px0)) / W
        gy0 = (py0 + by0 * (py1 - py0)) / H
        gx1 = (px0 + bx1 * (px1 - px0)) / W
        gy1 = (py0 + by1 * (py1 - py0)) / H
        out.append({"text": text, "score": round(score, 4), "box": [round(gx0, 5), round(gy0, 5), round(gx1 - gx0, 5), round(gy1 - gy0, 5)]})
    return out


def merge(texts):
    result = []
    for t in texts:
        dup = next((r for r in result if r["text"] == t["text"] and iou(r["box"], t["box"]) > 0.5), None)
        if dup is None:
            result.append(t)
        elif t["score"] > dup["score"]:
            dup.update(t)
    return result


def iou(a, b):
    ax1, ay1, bx1, by1 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0, min(ax1, bx1) - max(a[0], b[0])), max(0, min(ay1, by1) - max(a[1], b[1]))
    inter = iw * ih
    return inter / max(1e-9, a[2] * a[3] + b[2] * b[3] - inter)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--images", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--labels")
    ap.add_argument("--no-detector", action="store_true")
    ap.add_argument("--min-height", type=float, default=0.0,
                    help="skip OCR on vehicles shorter than this fraction of the frame height")
    ap.add_argument("--skip-scene", action="store_true", help="no whole-frame OCR (used when no vehicle is found)")
    ap.add_argument("--recursive", action="store_true", help="images may sit in sub-folders (e.g. one per video)")
    ap.add_argument("--only", help="process only names starting with this prefix (to split a run across processes)")
    args = ap.parse_args()
    det = TextDetector(os.path.join(args.models, "det.onnx"))
    rec = TextRecognizer(os.path.join(args.models, "rec.onnx"))
    yolo = None
    if not args.no_detector:
        from ultralytics import YOLOE
        yolo = YOLOE(os.path.join(args.models, "yoloe-11s-seg.pt"))
        yolo.set_classes(PROMPTS, yolo.get_text_pe(PROMPTS))
    if args.recursive:
        names = sorted(os.path.relpath(os.path.join(d, f), args.images).replace(os.sep, "/")
                       for d, _, fs in os.walk(args.images) for f in fs if f.lower().endswith((".jpg", ".png")))
    else:
        names = sorted(os.listdir(args.images))
    if args.only:
        names = [n for n in names if n.startswith(args.only)]
    if args.labels:
        wanted = {e["image"] for e in json.load(open(args.labels, encoding="utf-8"))["images"]}
        names = [n for n in names if n in wanted]
    frames = []
    # One JSON line per frame as it completes, so a long run is never lost; the final file is written at the end.
    checkpoint = open(args.out + "l", "a", encoding="utf-8")
    done = set()
    if os.path.exists(args.out + "l"):
        for line in open(args.out + "l", encoding="utf-8"):
            try:
                frame = json.loads(line); frames.append(frame); done.add(frame["image"])
            except ValueError:
                pass
    for name in names:
        if name in done:
            continue
        image = cv2.imread(os.path.join(args.images, name))
        if image is None:
            continue
        started = time.perf_counter()
        vehicles = []
        if yolo is not None:
            res = yolo.predict(image[:, :, ::-1].copy(), imgsz=512, conf=0.25, verbose=False)[0]
            H, W = image.shape[:2]
            for i in np.argsort(-res.boxes.conf.cpu().numpy())[:3]:
                x0, y0, x1, y1 = res.boxes.xyxy[i].cpu().numpy().tolist()
                box = [x0 / W, y0 / H, x1 / W, y1 / H]
                if box[3] - box[1] < args.min_height:
                    continue
                texts = read_region(image, box, det, rec)
                # The app's second pass: the upper 55 % of the vehicle, enlarged up to 1600 px wide.
                upper = [box[0], box[1], box[2], box[1] + (box[3] - box[1]) * 0.55]
                texts = merge(texts + read_region(image, upper, det, rec))
                vehicles.append({"kind": KINDS[int(res.boxes.cls[i])], "score": round(float(res.boxes.conf[i]), 4),
                                 "box": [round(box[0], 5), round(box[1], 5), round(box[2] - box[0], 5), round(box[3] - box[1], 5)],
                                 "texts": texts})
        whole = [] if args.skip_scene or vehicles else read_region(image, [0, 0, 1, 1], det, rec, upscale_to=2400)
        frames.append({"image": name, "width": image.shape[1], "height": image.shape[0], "vehicles": vehicles,
                       "sceneTexts": whole, "ms": round((time.perf_counter() - started) * 1000)})
        checkpoint.write(json.dumps(frames[-1], ensure_ascii=False) + "\n")
        checkpoint.flush()
        print(name, len(vehicles), "vehicles", len(whole), "scene texts", file=sys.stderr)
    json.dump({"engine": "pc: yoloe-11s-seg.pt + PP-OCRv5 mobile det + latin_PP-OCRv5_mobile_rec (onnxruntime CPU)",
               "frames": frames}, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
