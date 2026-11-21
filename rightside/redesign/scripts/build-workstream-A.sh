#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p dist/workstream-A2
out=$(mktemp -d "$(pwd)/dist/workstream-A2/build.XXXXXX")
printf 'Snapshot/build: %s\n' "$out"
# A stable full source/resource/project copy avoids compiling other owners' in-flight edits.
cp -cR apps/ios "$out/ios"
xcodebuild -jobs 2 -project "$out/ios/RightSide.xcodeproj" -scheme RightSide -configuration Debug \
 -destination 'generic/platform=iOS Simulator' -derivedDataPath "$out/DerivedData" \
 -resultBundlePath "$out/build.xcresult" CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
 build-for-testing > "$out/build.log" 2>&1
printf 'PASS app + unit/UI target build-for-testing; no simulator launched. Log: %s/build.log\n' "$out"
