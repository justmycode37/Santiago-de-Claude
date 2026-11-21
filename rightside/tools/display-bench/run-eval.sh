#!/usr/bin/env bash
# Replay the labelled Bern video passes through the app's display-matching code and print the comparison.
# Usage: [DATA=data-holdout] rightside/tools/display-bench/run-eval.sh [path/to/swiftc] [--why|--wrong|--bench]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/../../redesign/apps/ios/RightSide"
swiftc="${1:-swiftc}"; shift || true
out="$(mktemp -d)"
"$swiftc" -O -swift-version 5 -o "$out/display-eval" \
  "$app/Sensors/VehicleEvidence.swift" "$app/Sensors/DepartureDisplayMatcher.swift" "$app/Sensors/VehiclePositionEvidence.swift" \
  "$app/Spatial/GeoARAlignment.swift" "$here/main.swift"
"$out/display-eval" "$here/${DATA:-data}" "$@"
