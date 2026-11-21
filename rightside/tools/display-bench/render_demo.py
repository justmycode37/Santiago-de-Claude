import json, os, subprocess, sys, textwrap
import cv2
S, name, title = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.load(open(f"{S}/demo/{name}.json", encoding="utf-8"))
frames_dir = f"{S}/holdout/frames"
colors = {"visualCandidate": (60, 200, 60), "conflicting": (40, 40, 230), "unknown": (160, 160, 160), "verifiedService": (200, 200, 0)}
tmp = f"{S}/demo/{name}.avi"
writer = None
for r in rows:
    img = cv2.imread(os.path.join(frames_dir, r["image"]))
    H, W = img.shape[:2]
    x, y, w, h = r["box"]
    c = colors.get(r["state"], (255, 255, 255))
    cv2.rectangle(img, (int(x * W), int(y * H)), (int((x + w) * W), int((y + h) * H)), c, 6)
    def band(lines, y0, scale=0.9):
        hh = 34 * len(lines) + 14
        over = img.copy(); cv2.rectangle(over, (0, y0), (W, y0 + hh), (0, 0, 0), -1)
        cv2.addWeighted(over, 0.65, img, 0.35, 0, img)
        for k, (t, col) in enumerate(lines):
            cv2.putText(img, t, (16, y0 + 34 * (k + 1)), cv2.FONT_HERSHEY_SIMPLEX, scale, col, 2, cv2.LINE_AA)
    band([(title, (255, 255, 255)), (f"Decision: {r['label']}  [{r['reason']}]", c)], 0)
    ocr = "OCR: " + " | ".join(r["texts"][:8]) if r["texts"] else "OCR: (nothing read on this vehicle)"
    lines = [(l, (230, 230, 230)) for l in textwrap.wrap(ocr, 120)[:2]] + [("This frame vs board: " + r["match"], (0, 220, 255))]
    band(lines, H - (34 * len(lines) + 14), 0.75)
    if writer is None:
        writer = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"MJPG"), 2, (W, H))
    writer.write(img)
writer.release()
out = f"{S}/demo/{name}.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-vf", "scale=1280:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", out], check=True)
os.remove(tmp); print(out)
