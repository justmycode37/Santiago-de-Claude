#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p dist/hill-climb-m1
out=$(mktemp -d "$(pwd)/dist/hill-climb-m1/ios-typecheck.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
frameworks="$DEVELOPER_DIR/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/iPhoneSimulator.platform/Developer/usr/lib"
printf 'Output: %s\nSDK: %s\n' "$out" "$sdk"
common=(-target arm64-apple-ios17.0-simulator -sdk "$sdk" -swift-version 5 -strict-concurrency=complete -warnings-as-errors)
xcrun swiftc "${common[@]}" -emit-module -enable-testing -module-name RightSide \
  apps/ios/RightSide/Core/{JSONValue,DTOs,DomainBridge,JourneyCache,NavigationGuidance,StopDepartures,CommunityTransport,JourneyStore,OJPXML,OJPModels,OJPDecoder,OJPTransport,OJPJourneyAdapter,OJPServiceUpdate}.swift \
  apps/ios/RightSide/UI/JourneyLanguage.swift \
  apps/ios/RightSide/Sensors/{SensorEvidence,LocationController}.swift \
  -emit-module-path "$out/RightSide.swiftmodule"
xcrun swiftc "${common[@]}" -typecheck -F "$frameworks" -I "$libraries" -I "$out" \
  apps/ios/RightSideTests/{JourneyStoreRegressionTests,DomainBridgeTests,NativeCoreTests}.swift
printf 'PASS iOS SDK production controller + store module and regression test typecheck (no simulator execution).\n'
