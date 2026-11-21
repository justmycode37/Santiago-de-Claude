#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "STOP REQUESTED"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
out="$(pwd)/dist/workstream-C"
mkdir -p "$out"
date -u '+compute_start=%Y-%m-%dT%H:%M:%SZ' > "$out/compute-operation.log"
trap 'date -u "+compute_end=%Y-%m-%dT%H:%M:%SZ" >> "$out/compute-operation.log"' EXIT
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
python3 scripts/generate-spatial-benchmark.py
python3 scripts/prepare-spatial-site.py "$out/benchmark/synthetic-survey/survey.json" "$out/benchmark/synthetic-survey/checkpoints.json" "$out/benchmark/synthetic-site"
# Exercise the same folder resource lookup as the app without a hosted simulator.
mkdir -p "$out/SpatialResources.bundle/Contents/Resources/SpatialPacks"
cp apps/ios/RightSide/Resources/SpatialPacks/bern-spatial.json "$out/SpatialResources.bundle/Contents/Resources/SpatialPacks/bern-spatial.json"
cat > "$out/SpatialResources.bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>rightside.spatial.tests</string><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>
PLIST
xcrun swiftc -O -swift-version 5 -strict-concurrency=complete -warnings-as-errors -D SPATIAL_HARNESS \
 -F "$frameworks" -I "$libraries" -L "$libraries" -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" \
 apps/ios/RightSide/Spatial/*.swift apps/ios/RightSide/Sensors/LocalLandmarkGeometry.swift \
 apps/ios/RightSideTests/SpatialReferenceTests.swift scripts/check-spatial.swift -o "$out/spatial-checks"
SPATIAL_PACK_PATH="$(pwd)/apps/ios/RightSide/Resources/SpatialPacks/bern-spatial.json" \
SPATIAL_BUNDLE_PATH="$out/SpatialResources.bundle" SPATIAL_SYNTHETIC_SITE="$out/benchmark/synthetic-site/site.json" \
 "$out/spatial-checks" "$out/benchmark/heldout.json" "$out/benchmark/results.json" | tee "$out/checks.log"
