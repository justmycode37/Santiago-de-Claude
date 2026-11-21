#!/usr/bin/env python3
"""Bounded different-engine feasibility probe, not the integrated native camera path.

Engine: official PaddleOCR latin_PP-OCRv5_mobile_rec ONNX weights; execution:
Microsoft ONNX Runtime CPU (Python binding). No text correction, route vocabulary,
custom dictionary, fuzzy match, beam search or expected-label input. Preprocessing
follows the model's published BGR/CHW/48px contract; CTC is greedy blank/repeat removal.
Model/config: Apache-2.0 PaddlePaddle authors. ORT: MIT Microsoft. See asset manifest.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import time

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
import cv2
import numpy as np
import onnxruntime as ort
import yaml

p = argparse.ArgumentParser()
p.add_argument("model_dir", type=Path)
p.add_argument("image", type=Path)
p.add_argument("observed_regions", type=Path)
p.add_argument("output", type=Path)
p.add_argument("--project-root", type=Path)
p.add_argument("--bus-regions", type=Path)
a = p.parse_args()
root = a.project_root or Path(__file__).resolve().parents[1]
assert not json.loads((root.parent / "docs/hill-climb/STATE.json").read_text())["stopRequested"]
cv2.setNumThreads(1)
config = yaml.safe_load((a.model_dir / "inference.yml").read_text())
assert config["Global"]["model_name"] == "latin_PP-OCRv5_mobile_rec"
characters = [""] + config["PostProcess"]["character_dict"] + [" "]
options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
options.enable_mem_pattern = False
load_at = time.monotonic()
session = ort.InferenceSession(str(a.model_dir / "inference.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
load_ms = (time.monotonic()-load_at)*1000
input_info = session.get_inputs()[0]
rows = []
cases = [("tram", a.image, a.observed_regions)]
if a.bus_regions:
    cases.append(("bus", root/"evaluation/images/bus.jpg", a.bus_regions))
for sample, path, regions in cases:
 original = cv2.imread(str(path))
 assert original is not None and max(original.shape[:2]) <= 5500
 observed = json.loads(regions.read_text())
 # Only actual unmodified body/upper OCR proposals, preferring actual alphabetic rows.
 # Numeric body/plate text is included as a separate negative recognizer control.
 all_proposals = [(r["name"], t) for r in observed if r["name"].endswith(("-body", "-upper")) for t in r["texts"] if t["confidence"] >= 0.3]
 letters = [p for p in all_proposals if any(c.isalpha() for c in p[1]["text"])]
 numbers = [p for p in all_proposals if not any(c.isalpha() for c in p[1]["text"])]
 proposals = letters[:2]+numbers[-1:]
 for longest in [1280, 2560]:
    scale = min(1, longest/max(original.shape[:2]))
    image = cv2.resize(original, (round(original.shape[1]*scale), round(original.shape[0]*scale)))
    for index, (origin, proposal) in enumerate(proposals):
        x, y, w, h = proposal["box"]
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1):
            continue
        # Fixed crop padding variants are diagnostic; neither uses expected words.
        for padding in [0.0, 0.15]:
            px = h*image.shape[0]*padding
            left, top = max(0,math.floor(x*image.shape[1]-px)), max(0,math.floor(y*image.shape[0]-px))
            right, bottom = min(image.shape[1],math.ceil((x+w)*image.shape[1]+px)), min(image.shape[0],math.ceil((y+h)*image.shape[0]+px))
            crop = image[top:bottom,left:right]
            if min(crop.shape[:2]) < 4:
                continue
            width = min(1024, max(1, math.ceil(48*crop.shape[1]/crop.shape[0])))
            padded_width = max(320, width)
            if isinstance(input_info.shape[3], int):
                padded_width = input_info.shape[3]
                width = min(width, padded_width)
            tensor = np.zeros((1,3,48,padded_width), dtype=np.float32)
            resized = cv2.resize(crop, (width,48), interpolation=cv2.INTER_LINEAR).astype(np.float32)
            tensor[0,:,:,:width] = resized.transpose(2,0,1)/127.5-1
            start = time.monotonic()
            logits = session.run(None, {input_info.name:tensor})[0]
            elapsed_ms = (time.monotonic()-start)*1000
            assert logits.shape[0] == 1 and logits.shape[2] == len(characters), (logits.shape,len(characters))
            values = logits[0]
            indices = values.argmax(axis=1)
            confidences = values.max(axis=1)
            selected = [i for i,v in enumerate(indices) if v != 0 and (i == 0 or v != indices[i-1])]
            text = "".join(characters[int(indices[i])] for i in selected)
            probabilities = [float(confidences[i]) for i in selected]
            row = {"sample":sample,"imageSHA256":hashlib.sha256(path.read_bytes()).hexdigest(),"regionsSHA256":hashlib.sha256(regions.read_bytes()).hexdigest(),
                   "sceneLongestSide":longest,"origin":origin,"proposalIndex":index,"visionProposalText":proposal["text"],"proposalBox":proposal["box"],
                   "padding":padding,"cropPixels":[left,top,right-left,bottom-top],"inputTensor":list(tensor.shape),"observedText":text,
                   "meanCharacterScore":float(np.mean(probabilities)) if probabilities else 0,
                   "minimumCharacterScore":min(probabilities,default=0),"characterScores":probabilities,"inferenceMS":elapsed_ms}
            rows.append(row)
            print(json.dumps(row,ensure_ascii=False),flush=True)
for value in [0,127]:
    tensor = np.full((1,3,48,320), value/127.5-1, dtype=np.float32)
    start = time.monotonic()
    values = session.run(None,{input_info.name:tensor})[0][0]
    indices = values.argmax(axis=1)
    selected = [i for i,v in enumerate(indices) if v != 0 and (i == 0 or v != indices[i-1])]
    rows.append({"sample":"controlled-uniform-unreadable","pixelValue":value,
                 "observedText":"".join(characters[int(indices[i])] for i in selected),
                 "characterScores":[float(values[i,indices[i]]) for i in selected],"inferenceMS":(time.monotonic()-start)*1000})
assert len(rows) <= 32
report = {"engine":"PaddleOCR official latin_PP-OCRv5_mobile_rec ONNX; ORT CPU Python binding prototype",
          "onnxruntimeVersion":ort.__version__,"modelSHA256":hashlib.sha256((a.model_dir/"inference.onnx").read_bytes()).hexdigest(),
          "imageSHA256":hashlib.sha256(a.image.read_bytes()).hexdigest(),"regionsSHA256":hashlib.sha256(a.observed_regions.read_bytes()).hexdigest(),
          "sourceSHA256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"loadMS":load_ms,
          "peakResidentBytes":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,"rows":rows,"actualCropInvocations":len(rows),
          "integratedNativePath":False,"fieldEncounters":0,"expectedWordsSupplied":False}
a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2))
