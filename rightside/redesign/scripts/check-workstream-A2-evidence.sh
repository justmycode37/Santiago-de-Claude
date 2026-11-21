#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
module="${1:?Pass immutable current host-check output directory}"
out=$(mktemp -d "$(pwd)/dist/workstream-A2/evidence.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
cp scripts/check-workstream-A2-{before,mapkit,process}.swift "$out/"
baseline="$(pwd)/dist/workstream-A/checks.M3KBS4"
xcrun swiftc -parse-as-library -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
 -I "$baseline" -L "$baseline" -lRightSide -Xlinker -rpath -Xlinker "$baseline" \
 "$out/check-workstream-A2-before.swift" -o "$out/before-check"
set +e
"$out/before-check" "$out"
result=$?
set -e
printf 'Before reproduction exit: %s (expected1: two missing legs)\n' "$result"
[[ "$result" == 1 ]]
xcrun swiftc -parse-as-library -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
 -I "$module" -L "$module" -lRightSide -Xlinker -rpath -Xlinker "$module" \
 "$out/check-workstream-A2-mapkit.swift" -o "$out/mapkit-check"
if [[ "${SKIP_LIVE_MAPKIT:-0}" != 1 ]]; then "$out/mapkit-check" "$out"; fi

xcrun swiftc -parse-as-library -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
 -I "$module" -L "$module" -lRightSide -Xlinker -rpath -Xlinker "$module" \
 "$out/check-workstream-A2-process.swift" -o "$out/process-check"
"$out/process-check" save "$out/recording-process-bundle.json"
"$out/process-check" restore "$out/recording-process-bundle.json"

cp "$module/"{domain.js,bern-demo.json} "$out/"
"$out/process-check" journey-save "$out/recording-full-journey-bundle.json" --ui-testing "save-$(basename "$out")"
"$out/process-check" journey-restore "$out/recording-full-journey-bundle.json" --ui-testing "restore-$(basename "$out")"
