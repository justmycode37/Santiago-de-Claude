#!/usr/bin/env python3
"""Frozen real-frame replay. Native execution requires a separately granted compute slot."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("manifest", type=Path)
parser.add_argument("--preflight-only", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
guard = root.parent / "docs/hill-climb/execution_guard.py"
def require_scope():
    subprocess.run(["python3", str(guard), "B3"], check=True)
require_scope()
parent = root / "dist/hill-climb-b3"
out = Path(tempfile.mkdtemp(prefix="temporal.", dir=parent))
record = {"started": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "capSecondsPerOperation": 300, "preflightOnly": args.preflight_only, "sourceHashes": {}}
print(out, flush=True)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

try:
    manifest_path = args.manifest.resolve()
    data = json.loads(manifest_path.read_text())
    assert data.get("mediaStatus") == "acquired", "original clip unavailable; no actual PTS frames or frozen annotations"
    frozen = manifest_path.with_suffix(".sha256").read_text().split()[0]
    assert sha(manifest_path) == frozen, "annotation manifest changed after freeze"
    assert data["schemaVersion"] == 1 and data["annotationMethod"] == "manual-before-inference"
    assert data["author"] and data["licenceURL"]
    original = manifest_path.parent / data["originalPath"]
    assert original.is_file() and original.stat().st_size <= 40_000_000
    assert sha(original) == data["originalSHA256"]
    frames = data["frames"]
    assert 3 <= len(frames) <= 48, "real temporal frames absent or outside bound"
    assert frames[-1]["sourcePTS"] - frames[0]["sourcePTS"] <= 12
    assert all(a["sourcePTS"] < b["sourcePTS"] for a, b in zip(frames, frames[1:]))
    negative = data.get("evaluationRole") == "unreadable-negative-only"
    assert data.get("evaluationRole") in ("positive-utility", "unreadable-negative-only")
    assert data["expectedChecks"] == 1 + sum((7 + 2 * len(f["annotations"])) if negative else (1 + 8 * len(f["annotations"])) for f in frames)
    positives = [a for f in frames for a in f["annotations"] if a["requiresPositive"]]
    assert not positives if negative else bool(positives), "role must preserve explicit positive utility requirement"
    for frame in frames:
        path = manifest_path.parent / frame["path"]
        assert path.is_file() and path.stat().st_size <= 20_000_000
        assert sha(path) == frame["sha256"]
    record.update(preflight="passed", originalSHA256=sha(original), annotationSHA256=frozen,
                  actualSourceFrames=len(frames), expectedChecks=data["expectedChecks"], evaluationRole=data["evaluationRole"], positiveUtilityAssessed=not negative)
except (AssertionError, KeyError, OSError, ValueError) as error:
    record.update(preflight="blocked", error=str(error), nativeLaunched=False,
                  actualSourceFrames=0, inferenceAcceptance=False)
    (out / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    print("No native launch: " + str(error), flush=True)
    raise SystemExit(3)

if args.preflight_only:
    record["nativeLaunched"] = False
    (out / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    raise SystemExit(0)

sources = [root / "apps/ios/RightSide/Sensors" / (name + ".swift") for name in
           ["VehicleEvidence", "TransportSegmenter", "VehicleDisplayRecognition", "VehicleDisplayRuntime",
            "SensorEvidence", "CameraGuidanceModels", "VehicleWireAdapter", "CameraEvidenceLifecycle", "TransportDataPacks"]]
sources += [root / "apps/ios/RightSide/Core/JSONValue.swift", root / "scripts/check-camera-temporal-replay.swift"]
for source in sources:
    shutil.copyfile(source, out / source.name)
    record["sourceHashes"][source.name] = sha(source)
shutil.copyfile(Path(__file__), out / Path(__file__).name)
record["sourceHashes"][Path(__file__).name] = sha(Path(__file__))
shutil.copyfile(manifest_path, out / "annotations.json")
record["nativeLaunched"] = True
record["load"] = subprocess.check_output(["uptime"], text=True).strip()
record["swap"] = subprocess.check_output(["sysctl", "vm.swapusage"], text=True).strip()
model_roots = [root / "dist/hill-climb-m3/recorded.WidXkI/TransportSegmenter.mlmodelc",
               parent / "conversion.zhizqi_c/VehicleDisplayRecognizer.mlmodelc"]
record["modelFileHashes"] = {str(base.relative_to(root)): {str(p.relative_to(base)):sha(p) for p in sorted(base.rglob("*")) if p.is_file()} for base in model_roots}
record["dictionarySHA256"] = sha(parent / "conversion.zhizqi_c/display-characters.json")
environment = dict(os.environ, OMP_NUM_THREADS="1", VECLIB_MAXIMUM_THREADS="1",
                   CAMERA_REPLAY_STATE=str(root.parent / "docs/hill-climb/STATE.json"))

def run(command, name):
    require_scope()
    started = time.monotonic()
    record[name] = {"command": list(map(str, command)), "started": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (out / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    with (out / (name + ".log")).open("w") as log:
        try:
            result = subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=300)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 124
    record[name].update(exitCode=code, seconds=time.monotonic()-started)
    record["cumulativeChildPeakResidentBytes"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    (out / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    print((out / (name + ".log")).read_text()[-6000:], flush=True)
    return code

code = run(["xcrun", "swiftc", "-O", "-whole-module-optimization", "-target", "arm64-apple-macos14.0",
            "-swift-version", "5", "-strict-concurrency=complete", "-warnings-as-errors",
            *[str(out / p.name) for p in sources], "-o", str(out / "experiment")], "compile")
if code:
    raise SystemExit(code)
display = parent / "conversion.zhizqi_c"
raise SystemExit(run([str(out / "experiment"), str(root / "dist/hill-climb-m3/recorded.WidXkI/TransportSegmenter.mlmodelc"),
                      str(manifest_path), str(out / "report.json"), str(display / "VehicleDisplayRecognizer.mlmodelc"),
                      str(display / "display-characters.json")], "replay"))
