#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"]'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/hill-climb-b3
out=$(mktemp -d "$(pwd)/dist/hill-climb-b3/native.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
cp apps/ios/RightSide/Sensors/{VehicleEvidence,VehicleDisplayRecognition}.swift "$out/"
cp apps/ios/RightSideTests/VehicleDisplayRecognitionTests.swift "$out/"
python3 - "$out" <<'PY'
import re,sys
from pathlib import Path
out=Path(sys.argv[1]);count=len(re.findall(r'    func test\w+\(', (out/'VehicleDisplayRecognitionTests.swift').read_text()))
(out/'main.swift').write_text('import XCTest\nlet suite=VehicleDisplayRecognitionTests.defaultTestSuite\nsuite.run()\nexit(suite.testRun?.hasSucceeded == true && suite.testRun?.executionCount == '+str(count)+' ? 0 : 1)\n')
PY
shasum -a 256 "$out/"*.swift > "$out/source-sha256.txt"
xcrun swiftc -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
  -F "$frameworks" -I "$libraries" -L "$libraries" -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" \
  "$out/VehicleEvidence.swift" "$out/VehicleDisplayRecognition.swift" "$out/VehicleDisplayRecognitionTests.swift" "$out/main.swift" -o "$out/checks"
"$out/checks"
