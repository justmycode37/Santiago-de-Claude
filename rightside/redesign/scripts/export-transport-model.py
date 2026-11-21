#!/usr/bin/env python3
"""Acquire official weights; bake text prompts; export real FP16 Core ML at 512px.

Run in the isolated .venv-vision. Ultralytics weights/code are AGPL-3.0;
this script does not acquire an enterprise license or license the application.
No text encoder, Python, or network inference is required on the phone.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'research/model-export'
WORK.mkdir(parents=True, exist_ok=True)
os.chdir(WORK)
(WORK / 'settings').mkdir(exist_ok=True)
os.environ['YOLO_CONFIG_DIR'] = str(WORK / 'settings')
from ultralytics import YOLOE
import coremltools as ct

weights = Path('yoloe-11s-seg.pt')
weights_url = 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yoloe-11s-seg.pt'
if not weights.exists():
    urllib.request.urlretrieve(weights_url, weights)
expected_weights_hash = '8e439445c87338b79d9ce21dec109f4621e26df67e94d26ea1a98c1e64dce3e3'
if hashlib.sha256(weights.read_bytes()).hexdigest() != expected_weights_hash:
    raise RuntimeError('Official checkpoint checksum mismatch; refusing to load weights')
model = YOLOE(str(weights))
classes = ['bus', 'tram', 'train']
prompts = ['city bus', 'tramway', 'train']
model.set_classes(classes, model.get_text_pe(prompts))
model.save('transport-prompted.pt')
exported = model.export(format='coreml', imgsz=512, half=True, nms=False, batch=1, device='cpu')
destination = ROOT / 'apps/ios/RightSide/Resources/TransportSegmenter.mlpackage'
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(exported, destination)
spec = ct.models.MLModel(str(destination), skip_model_load=True).get_spec()
manifest = {
    'schemaVersion': 1, 'id': 'transport-yoloe-11s-512', 'version': '2',
    'source': 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yoloe-11s-seg.pt',
    'license': 'AGPL-3.0; proprietary deployment requires separate licensing review',
    'classes': classes, 'textPrompts': prompts, 'inputSize': 512, 'precision': 'float16',
    'preprocessing': 'RGB 0..1, centered square letterbox, padding RGB(114,114,114)',
    'outputs': [{'name': o.name, 'shape': list(o.type.multiArrayType.shape)} for o in spec.description.output],
    'weightsSHA256': hashlib.sha256(Path('yoloe-11s-seg.pt').read_bytes()).hexdigest(),
    'files': {str(p.relative_to(destination)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(destination.rglob('*')) if p.is_file()},
    'validation': 'Zero-shot transport prompts. Not a calibrated classifier; field evaluation required.'
}
(ROOT / 'apps/ios/RightSide/Resources/TransportPacks/model-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
