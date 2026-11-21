#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p dist/hill-climb-m3
out=$(mktemp -d "$(pwd)/dist/hill-climb-m3/recorded.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
python3 - "$out" <<'PY'
import hashlib, json, sys
from pathlib import Path
out = Path(sys.argv[1]); rows=json.loads(Path('evaluation/image-sources.json').read_text())
for row in rows:
    p=Path('evaluation/images')/(row['id']+'.jpg')
    assert hashlib.sha256(p.read_bytes()).hexdigest()==row['sha256'], str(p)
manifest=json.loads(Path('apps/ios/RightSide/Resources/TransportPacks/model-manifest.json').read_text())
for name, digest in manifest['files'].items():
    p=Path('apps/ios/RightSide/Resources/TransportSegmenter.mlpackage')/name
    assert hashlib.sha256(p.read_bytes()).hexdigest()==digest, str(p)
(out/'image-sources.json').write_text(json.dumps(rows,indent=2))
(out/'model-manifest.json').write_text(json.dumps(manifest,indent=2))
print('PASS all 4 original photograph hashes and bundled model file hashes')
PY
xcrun coremlcompiler compile apps/ios/RightSide/Resources/TransportSegmenter.mlpackage "$out"
mkdir -p "$out/production"
sources=()
for source in apps/ios/RightSide/Core/JSONValue.swift apps/ios/RightSide/Sensors/{SensorEvidence,CameraGuidanceModels,VehicleEvidence,VehicleWireAdapter,CameraEvidenceLifecycle,TransportDataPacks,TransportSegmenter}.swift; do
  if [[ "$(basename "$source")" == TransportSegmenter.swift && -n "${CAMERA_PIPELINE_SOURCE:-}" ]]; then source="$CAMERA_PIPELINE_SOURCE"; fi
  snapshot="$out/production/$(basename "$source")"
  cp "$source" "$snapshot"
  sources+=("$snapshot")
done
cp scripts/check-hill-climb-camera-replay.swift "$out/replay.swift"
shasum -a 256 "${sources[@]}" "$out/replay.swift" > "$out/source-sha256.txt"
xcrun swiftc -O -whole-module-optimization -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
 "${sources[@]}" "$out/replay.swift" -o "$out/recorded-checks"
"$out/recorded-checks" "$out/TransportSegmenter.mlmodelc" "$(pwd)/evaluation/images" "$out"
