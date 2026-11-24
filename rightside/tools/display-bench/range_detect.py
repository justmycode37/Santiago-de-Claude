"""Reading-range pilot, stage A: vehicles in every frame of a denser extraction (docs/ar-recognition-plan.md step 3).

Same detector and settings as ocr_frames.py (YOLOE-11s-seg, the app's text prompts, imgsz 512, conf 0.25), but no
minimum height and no OCR: boxes only, so far vehicles are kept. One JSON line per frame.

    python -I range_detect.py --models DIR --frames DIR/VIDEO --out detections.jsonl
Frames: ffmpeg -i VIDEO.mp4 -vf fps=5 -q:v 3 DIR/VIDEO/%05d.jpg (frame n was taken at (n - 1) / fps s).
"""
import argparse, json, os, sys

import cv2
import numpy as np

PROMPTS = ["city bus", "tramway", "train"]
KINDS = ["bus", "tram", "train"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    from ultralytics import YOLOE
    yolo = YOLOE(os.path.join(a.models, "yoloe-11s-seg.pt"))
    yolo.set_classes(PROMPTS, yolo.get_text_pe(PROMPTS))
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(l)["image"] for l in open(a.out, encoding="utf-8") if l.strip()}
    video = os.path.basename(os.path.normpath(a.frames))
    with open(a.out, "a", encoding="utf-8") as out:
        for name in sorted(os.listdir(a.frames)):
            key = f"{video}/{name}"
            if key in done or not name.endswith(".jpg"):
                continue
            img = cv2.imread(os.path.join(a.frames, name))
            H, W = img.shape[:2]
            res = yolo.predict(img[:, :, ::-1].copy(), imgsz=512, conf=0.25, verbose=False)[0]
            boxes = []
            for i in np.argsort(-res.boxes.conf.cpu().numpy())[:6]:
                x0, y0, x1, y1 = res.boxes.xyxy[i].cpu().numpy().tolist()
                boxes.append({"kind": KINDS[int(res.boxes.cls[i])], "score": round(float(res.boxes.conf[i]), 4),
                              "box": [round(x0 / W, 5), round(y0 / H, 5), round((x1 - x0) / W, 5), round((y1 - y0) / H, 5)]})
            out.write(json.dumps({"image": key, "width": W, "height": H, "vehicles": boxes}) + "\n")
            out.flush()
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
