#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/hill-climb-m1
out=$(mktemp -d "$(pwd)/dist/hill-climb-m1/${CHECK_LABEL:-checks}.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\nStore: %s\n' "$out" "${STORE_SOURCE:-apps/ios/RightSide/Core/JourneyStore.swift}"
cp "${STORE_SOURCE:-apps/ios/RightSide/Core/JourneyStore.swift}" "$out/JourneyStore.tested.swift"
cp apps/ios/RightSideTests/JourneyStoreRegressionTests.swift "$out/JourneyStoreRegressionTests.tested.swift"
common=(-target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors)
xcrun swiftc "${common[@]}" -emit-library -emit-module -enable-testing -module-name RightSide \
  apps/ios/RightSide/Core/{JSONValue,DTOs,DomainBridge,JourneyCache,NavigationGuidance,StopDepartures,CommunityTransport,OJPXML,OJPModels,OJPDecoder,OJPTransport,OJPJourneyAdapter,OJPServiceUpdate}.swift \
  "${STORE_SOURCE:-apps/ios/RightSide/Core/JourneyStore.swift}" \
  apps/ios/RightSide/UI/JourneyLanguage.swift \
  apps/ios/RightSide/Sensors/SensorEvidence.swift scripts/check-hill-climb-recovery-location.swift \
  -emit-module-path "$out/RightSide.swiftmodule" -o "$out/libRightSide.dylib"
cp apps/ios/RightSide/Resources/{domain.js,bern-demo.json} "$out/"
xcrun swiftc "${common[@]}" -D HILL_CLIMB_RECOVERY_HARNESS \
  -F "$frameworks" -I "$libraries" -L "$libraries" -I "$out" -L "$out" -lRightSide \
  -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" -Xlinker -rpath -Xlinker "$out" \
  apps/ios/RightSideTests/{JourneyStoreRegressionTests,DomainBridgeTests,NativeCoreTests}.swift \
  scripts/check-hill-climb-recovery.swift -o "$out/recovery-checks"
"$out/recovery-checks" --ui-testing "recovery-$(basename "$out")"
