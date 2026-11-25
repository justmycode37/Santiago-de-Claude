# YOLOX

The AR camera's vehicle detector (`src/app/ar.ts`); why: `docs/ar-reading-range.md`, `docs/ar-labels-bench.md`. Both
files are Megvii's YOLOX COCO detectors (https://github.com/Megvii-BaseDetection/YOLOX, release 0.1.1rc0), Apache
License 2.0 (`LICENSE`), checked by the page against their SHA-256 before use (`src/yolox.ts`).

- `yolox_tiny_int8.onnx`: YOLOX-tiny with its weights quantized to 8 bits (onnxruntime's `quantize_dynamic`, QUInt8;
  `tools/quantize_yolox.py` makes it again). Modified from the original: weights quantized, nothing else. SHA-256
  `133f59eee2aff39d5e0cf7e19438d4c677fb64392ce7141b6afdb085db4cafaf`. The default.
- `yolox_nano.onnx`: YOLOX-nano, unchanged. SHA-256 `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`.
  Used when YOLOX-tiny is too slow on the phone.
