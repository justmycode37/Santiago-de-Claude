#!/usr/bin/env python3
"""Bounded native experiments. Launch only in the manager-granted owned compute window."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import resource

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["probe", "geometry", "replay", "retained", "live", "quad"])
parser.add_argument("--baseline", action="store_true")
parser.add_argument("--sample", default="tram", choices=["bus", "tram", "train", "tram-holdout"])
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
assert not json.loads((root.parent / "docs/hill-climb/STATE.json").read_text())["stopRequested"]
parent = root / "dist/hill-climb-b3"
parent.mkdir(exist_ok=True, parents=True)
if args.mode == "quad":
    frozen = json.loads((parent / "quad-source-freeze.json").read_text())
    for relative, digest in frozen["files"].items():
        assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == digest, relative
out = Path(tempfile.mkdtemp(prefix=args.mode + ".", dir=parent))
sources = [root / "apps/ios/RightSide/Sensors" / (n + ".swift") for n in ["VehicleEvidence", "TransportSegmenter", "VehicleDisplayRecognition", "VehicleDisplayRuntime"]]
if args.mode not in ("probe", "geometry", "quad"):
    sources += [root / "apps/ios/RightSide/Core/JSONValue.swift"]
    sources += [root / "apps/ios/RightSide/Sensors" / (n + ".swift") for n in ["SensorEvidence", "CameraGuidanceModels", "VehicleWireAdapter", "CameraEvidenceLifecycle", "TransportDataPacks"]]
driver = root / "scripts" / ("check-hill-climb-camera-replay.swift" if args.mode == "retained" else "check-camera-multimodal-" + args.mode + ".swift")
sources.append(driver)
manifest = {"mode": args.mode, "sourceHashes": {}, "started": datetime.datetime.now(datetime.timezone.utc).isoformat(), "computeCapSecondsPerOperation": 300, "ownedJobs": 1}
for source in sources:
    if args.baseline and source.name == "TransportSegmenter.swift":
        source = parent / "baseline/TransportSegmenter.swift"
    shutil.copyfile(source, out / source.name)
    manifest["sourceHashes"][source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
if args.baseline:
    # API-only adapter for the immutable pre-B3 implementation; it never runs the
    # alternative engine or supplies observations. Same replay expectations/assertions.
    adapter = out / "baseline-api.swift"
    adapter.write_text("""import Foundation
struct VehicleRecognitionDiagnostic {
 let trackID:UUID
 let visionTexts:[VehicleText]
 let proposal:VehicleDisplayRecognitionPolicy.Proposal?
 let alternative:AlternativeDisplayObservation?
 let additionalAlternatives:[AlternativeDisplayObservation]
 let fallbackFailure:String?
 let proposalRejectionReason:String?
}
extension VehicleFrameResult {
 var recognitionDiagnostics:[VehicleRecognitionDiagnostic] { [] }
}
extension LocalVehiclePipeline {
 convenience init(modelURL:URL?,displayModelURL:URL?,displayCharactersURL:URL?) { self.init(modelURL:modelURL) }
}
""")
    sources.append(adapter)
    manifest["sourceHashes"][adapter.name] = hashlib.sha256(adapter.read_bytes()).hexdigest()
photos = json.loads((root / "evaluation/image-sources.json").read_text())
for photo in photos:
    assert hashlib.sha256((root / "evaluation/images" / (photo["id"] + ".jpg")).read_bytes()).hexdigest() == photo["sha256"]
(out / "image-sources.json").write_text(json.dumps(photos, indent=2))
model_manifest = json.loads((root / "apps/ios/RightSide/Resources/TransportPacks/model-manifest.json").read_text())
for name, digest in model_manifest["files"].items():
    assert hashlib.sha256((root / "apps/ios/RightSide/Resources/TransportSegmenter.mlpackage" / name).read_bytes()).hexdigest() == digest
(out / "model-manifest.json").write_text(json.dumps(model_manifest, indent=2))
# Reuse only the already-compiled, hash-verified bundled model from the accepted65 checkpoint.
cached = root / "dist/hill-climb-m3/recorded.WidXkI"
assert json.loads((cached / "model-manifest.json").read_text()) == model_manifest
model = cached / "TransportSegmenter.mlmodelc"
manifest["compiledModelFiles"] = {str(p.relative_to(model)): hashlib.sha256(p.read_bytes()).hexdigest() for p in model.rglob("*") if p.is_file()}
manifest["compiledModelPath"] = str(model)
manifest["hardware"] = subprocess.check_output(["sysctl", "-n", "hw.model", "hw.memsize", "hw.ncpu"], text=True).strip()
manifest["load"] = subprocess.check_output(["uptime"], text=True).strip()
manifest["swap"] = subprocess.check_output(["sysctl", "vm.swapusage"], text=True).strip()
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(out, flush=True)
display = parent / "conversion.zhizqi_c"
environment = dict(os.environ, OMP_NUM_THREADS="1", VECLIB_MAXIMUM_THREADS="1",
    CAMERA_DISPLAY_MODEL=str(display/"VehicleDisplayRecognizer.mlmodelc"),CAMERA_DISPLAY_CHARACTERS=str(display/"display-characters.json"))
def run(command, name):
    assert not json.loads((root.parent / "docs/hill-climb/STATE.json").read_text())["stopRequested"]
    manifest[name + "Started"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    manifest[name + "Command"] = list(map(str, command))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    started = time.monotonic()
    with (out / (name + ".log")).open("w") as log:
        try:
            result = subprocess.run(command, env=environment, cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=300)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 124
            manifest[name + "TimedOut"] = True
    manifest[name + "Seconds"] = time.monotonic()-started
    manifest[name + "ChildPeakResidentBytes"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    manifest[name + "Exit"] = code
    manifest[name + "Ended"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print((out / (name + ".log")).read_text()[-14000:], flush=True)
    return code
code = run(["xcrun", "swiftc", "-O", "-whole-module-optimization", "-target", "arm64-apple-macos14.0", "-swift-version", "5", "-strict-concurrency=complete", "-warnings-as-errors", *[str(out / p.name) for p in sources], "-o", str(out / "experiment")], "compile")
if code:
    raise SystemExit(code)
if args.mode in ("probe", "geometry"):
    command = [out / "experiment", model, root / "evaluation/images" / (args.sample + ".jpg"), out / "probe.json"]
else:
    command = [out / "experiment", model, root / "evaluation/images", out]
    if args.mode in ("replay", "quad"):
        fixture_report = parent / "replay.cmzbwjf_/report.json" if args.mode == "quad" else cached / "report.json"
        if args.mode == "quad":
            manifest["fixtureReportPath"] = str(fixture_report)
            manifest["fixtureReportSHA256"] = hashlib.sha256(fixture_report.read_bytes()).hexdigest()
        command += [fixture_report, display / "VehicleDisplayRecognizer.mlmodelc", display / "display-characters.json"]
raise SystemExit(run(list(map(str, command)), "experiment"))
