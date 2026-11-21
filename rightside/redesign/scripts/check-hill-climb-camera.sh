#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/hill-climb-m3
out=$(mktemp -d "$(pwd)/dist/hill-climb-m3/native.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
python3 - "$out" <<'PY'
import re, sys
from pathlib import Path
out = Path(sys.argv[1])
files = [Path('apps/ios/RightSideTests') / (name + '.swift') for name in ['CameraEvidenceLifecycleTests', 'CameraBoardingTests', 'VehicleEvidenceTests', 'TransportDecoderTests']]
entries = []
count = 0
for file in files:
    source = file.read_text()
    (out / file.name).write_text(source)
    count += len(re.findall(r'    func (test\w+)\(', source))
    entries.append('suite.addTest(' + file.stem + '.defaultTestSuite)')
(out / 'main.swift').write_text('import XCTest\nlet suite = XCTestSuite(name: "Camera lifecycle and existing vehicle semantics")\n' + '\n'.join(entries) + '\nsuite.run()\nexit(suite.testRun?.hasSucceeded == true && suite.testRun?.executionCount == ' + str(count) + ' ? 0 : 1)\n')
PY
cp apps/ios/RightSide/Resources/{domain.js,bern-demo.json} "$out/"
cp apps/ios/RightSide/Sensors/LiveCameraGuidance.swift "$out/LiveCameraGuidance.tested.swift"
mkdir -p "$out/production"
sources=()
for source in apps/ios/RightSide/Core/{JSONValue,DTOs}.swift apps/ios/RightSide/Sensors/{SensorEvidence,CameraGuidanceModels,VehicleEvidence,VehicleWireAdapter,CameraEvidenceLifecycle,CameraBoardingContext,TransportDataPacks,LocalLandmarkGeometry,TransportSegmenter}.swift apps/ios/RightSide/Spatial/LocalPoseConsensus.swift; do
  snapshot="$out/production/$(basename "$source")"
  cp "$source" "$snapshot"
  sources+=("$snapshot")
done
shasum -a 256 "${sources[@]}" "$out/"*Tests.swift > "$out/source-sha256.txt"
xcrun swiftc -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
  -F "$frameworks" -I "$libraries" -L "$libraries" \
  -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" \
  "${sources[@]}" "$out/"*Tests.swift \
  "$out/main.swift" -o "$out/camera-checks"
"$out/camera-checks"
