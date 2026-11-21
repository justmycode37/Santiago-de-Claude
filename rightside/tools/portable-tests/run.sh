#!/usr/bin/env bash
# Compile the platform-independent RightSide sources with these checks and run them.
# Works with a Swift toolchain on Linux (e.g. WSL) or macOS; no Xcode, simulator or device needed.
# Usage: rightside/tools/portable-tests/run.sh [path/to/swiftc]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/../../redesign/apps/ios/RightSide"
swiftc="${1:-swiftc}"
out="$(mktemp -d)"
"$swiftc" -O -swift-version 5 -o "$out/portable-tests" \
  "$app/Sensors/VehicleEvidence.swift" \
  "$app/Sensors/DepartureDisplayMatcher.swift" \
  "$app/Sensors/VehiclePositionEvidence.swift" \
  "$app/Spatial/GeoARAlignment.swift" \
  "$here/main.swift"
"$out/portable-tests"
