#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/workstream-A2
out=$(mktemp -d "$(pwd)/dist/workstream-A2/checks.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
mkdir -p "$out/source/RightSide/UI" "$out/source/RightSide/Sensors" "$out/source/scripts"
cp -cR apps/ios/RightSide/Core "$out/source/RightSide/Core"
cp -cR apps/ios/RightSideTests "$out/source/RightSideTests"
cp apps/ios/RightSide/UI/JourneyLanguage.swift "$out/source/RightSide/UI/"
cp apps/ios/RightSide/Sensors/SensorEvidence.swift "$out/source/RightSide/Sensors/"
cp scripts/check-hill-climb-recovery-location.swift scripts/check-workstream-A.swift scripts/check-workstream-A-provider.swift "$out/source/scripts/"
common=(-target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors)
xcrun swiftc "${common[@]}" -emit-library -emit-module -enable-testing -module-name RightSide \
 "$out/source/RightSide/Core/"{JSONValue,DTOs,DomainBridge,JourneyCache,NavigationGuidance,StopDepartures,JourneyReminders,MapServices,WalkingBundle,CommunityTransport,JourneyStore,OJPXML,OJPModels,OJPDecoder,OJPTransport,OJPJourneyAdapter,OJPServiceUpdate}.swift \
 "$out/source/RightSide/UI/JourneyLanguage.swift" "$out/source/RightSide/Sensors/SensorEvidence.swift" "$out/source/scripts/check-hill-climb-recovery-location.swift" \
 -emit-module-path "$out/RightSide.swiftmodule" -o "$out/libRightSide.dylib"
cp apps/ios/RightSide/Resources/{domain.js,bern-demo.json} "$out/"
xcrun swiftc "${common[@]}" -D HILL_CLIMB_RECOVERY_HARNESS \
 -F "$frameworks" -I "$libraries" -L "$libraries" -I "$out" -L "$out" -lRightSide \
 -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" -Xlinker -rpath -Xlinker "$out" \
 "$out/source/RightSideTests/"{JourneyStoreRegressionTests,DomainBridgeTests,NativeCoreTests,JourneyLanguageTests,NavigationGuidanceTests,WalkingBundleTests}.swift \
 "$out/source/scripts/check-workstream-A.swift" -o "$out/navigation-checks"
WALK_BUNDLE_ARTIFACT="$out/recording-three-leg-bundle.json" "$out/navigation-checks" --ui-testing "navigation-$(basename "$out")"
if [[ "${CHECK_LIVE_PROVIDER:-0}" == 1 ]]; then
 xcrun swiftc "${common[@]}" -parse-as-library -I "$out" -L "$out" -lRightSide -Xlinker -rpath -Xlinker "$out" \
  "$out/source/scripts/check-workstream-A-provider.swift" -o "$out/provider-checks"
 "$out/provider-checks" "$out" --ui-testing "provider-$(basename "$out")"
fi
