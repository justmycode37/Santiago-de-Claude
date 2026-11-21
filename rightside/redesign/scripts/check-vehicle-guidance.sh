#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/vision-v1/logs
xcrun swiftc -O -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
  -F "$frameworks" -I "$libraries" -L "$libraries" \
  -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" \
  apps/ios/RightSide/Sensors/VehicleEvidence.swift \
  apps/ios/RightSide/Sensors/TransportDataPacks.swift \
  apps/ios/RightSide/Sensors/LocalLandmarkGeometry.swift \
  apps/ios/RightSide/Sensors/TransportSegmenter.swift \
  apps/ios/RightSideTests/VehicleEvidenceTests.swift apps/ios/RightSideTests/TransportDecoderTests.swift scripts/check-vehicle-guidance.swift \
  -o dist/vision-v1/vehicle-checks
dist/vision-v1/vehicle-checks
