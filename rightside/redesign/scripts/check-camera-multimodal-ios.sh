#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p dist/hill-climb-b3
out=$(mktemp -d "$(pwd)/dist/hill-climb-b3/ios-typecheck.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
frameworks="$DEVELOPER_DIR/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/iPhoneSimulator.platform/Developer/usr/lib"
printf 'Output: %s\nSDK: %s\n' "$out" "$sdk"
common=(-target arm64-apple-ios17.0-simulator -sdk "$sdk" -swift-version 5 -strict-concurrency=complete -warnings-as-errors)
sources=()
mkdir -p "$out/production" "$out/tests"
while IFS= read -r source; do
  snapshot="$out/production/$(basename "$source")"
  cp "$source" "$snapshot"
  sources+=("$snapshot")
done < <(rg --files apps/ios/RightSide -g '*.swift' | sort)
cp apps/ios/RightSideTests/{CameraEvidenceLifecycleTests,CameraBoardingTests,VehicleEvidenceTests,VehicleDisplayRecognitionTests,TransportDecoderTests,LocalPoseFrameTests}.swift "$out/tests/"
shasum -a 256 "${sources[@]}" "$out/tests/"*.swift > "$out/source-sha256.txt"
xcrun swiftc "${common[@]}" -emit-module -enable-testing -module-name RightSide "${sources[@]}" -emit-module-path "$out/RightSide.swiftmodule"
xcrun swiftc "${common[@]}" -typecheck -F "$frameworks" -I "$libraries" -I "$out" \
  "$out/tests/"*.swift
printf 'PASS full production app source + camera, vehicle and decoder tests against iOS SDK (no simulator execution).\n'
