#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p dist/workstream-A
out=$(mktemp -d "$(pwd)/dist/workstream-A/ios.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
mkdir -p "$out/source"
sources=()
while IFS= read -r source; do cp "$source" "$out/source/$(basename "$source")"; sources+=("$out/source/$(basename "$source")"); done < <(rg --files apps/ios/RightSide -g '*.swift' | sort)
xcrun swiftc -emit-module -enable-testing -module-name RightSide -target arm64-apple-ios17.0-simulator \
 -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -swift-version 5 -strict-concurrency=complete \
 "${sources[@]}" -emit-module-path "$out/RightSide.swiftmodule"
printf 'PASS complete production Swift source module against iOS SDK; no hosted execution.\n'
