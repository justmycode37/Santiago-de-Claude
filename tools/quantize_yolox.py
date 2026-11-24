"""Make models/yolox/yolox_tiny_int8.onnx: YOLOX-tiny (Megvii, Apache-2.0, release 0.1.1rc0) with its weights quantized
to 8 bits, a quarter of the size and faster in onnxruntime-web (docs/ar-labels-bench.md measures it).

    pip install onnx==1.23.2 onnxruntime==1.32.0
    python3 -I tools/quantize_yolox.py OUT.onnx [yolox_tiny.onnx]

Without the second argument the release ONNX is downloaded. The result's SHA-256 must be the one in src/yolox.ts
(the page checks it); other onnx/onnxruntime versions may write a different file.
"""
import hashlib, os, sys, tempfile, urllib.request

from onnxruntime.quantization import QuantType, quantize_dynamic

URL = "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx"
TINY = "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7"
INT8 = "133f59eee2aff39d5e0cf7e19438d4c677fb64392ce7141b6afdb085db4cafaf"


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    out = sys.argv[1]
    src = sys.argv[2] if len(sys.argv) > 2 else os.path.join(tempfile.mkdtemp(), "yolox_tiny.onnx")
    if not os.path.exists(src):
        urllib.request.urlretrieve(URL, src)
    if sha(src) != TINY:
        sys.exit(f"{src}: not the release's yolox_tiny.onnx")
    quantize_dynamic(src, out, weight_type=QuantType.QUInt8)
    got = sha(out)
    print(out, got, "(as in src/yolox.ts)" if got == INT8 else f"DIFFERENT from src/yolox.ts ({INT8})")


if __name__ == "__main__":
    main()
