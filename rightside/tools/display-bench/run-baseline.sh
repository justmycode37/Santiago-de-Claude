#!/usr/bin/env bash
# Replays the same trials through the ORIGINAL snapshot's VehicleEvidence.swift (the "Import RightSide native iOS app" commit).
# Usage: [DATA=data-holdout] rightside/tools/display-bench/run-baseline.sh [path/to/swiftc]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
swiftc="${1:-swiftc}"
data="$here/${DATA:-data}"
out="$(mktemp -d)"
# BASELINE_FILE may point to that file when git cannot run here (e.g. a Windows worktree seen from WSL).
{ if [ -n "${BASELINE_FILE:-}" ]; then cat "$BASELINE_FILE"; else
    git -C "$here" show "$(git -C "$here" log --format=%H -1 --grep="^Import RightSide native iOS app")":rightside/redesign/apps/ios/RightSide/Sensors/VehicleEvidence.swift; fi; } \
  | sed 's/^import CoreGraphics$/#if canImport(CoreGraphics)\nimport CoreGraphics\n#endif/' > "$out/VehicleEvidence.swift"
"$swiftc" -O -swift-version 5 -o "$out/display-eval" "$here/../../redesign/apps/ios/RightSide/Sensors/VehicleEvidence.swift" \
  "$here/../../redesign/apps/ios/RightSide/Sensors/DepartureDisplayMatcher.swift" "$here/../../redesign/apps/ios/RightSide/Sensors/VehiclePositionEvidence.swift" \
  "$here/../../redesign/apps/ios/RightSide/Spatial/GeoARAlignment.swift" "$here/main.swift"
"$out/display-eval" "$data" --export-trials "$out/trials.json" > /dev/null
"$swiftc" -O -swift-version 5 -o "$out/baseline" "$out/VehicleEvidence.swift" "$here/baseline/main.swift"
"$out/baseline" "$data" "$out/trials.json"
