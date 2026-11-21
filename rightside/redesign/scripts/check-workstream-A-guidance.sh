#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
out=$(mktemp -d "$(pwd)/dist/workstream-A/guidance.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
mkdir -p "$out/source"
cp apps/ios/RightSide/Core/{JSONValue,DTOs,DomainBridge,MapServices,WalkingBundle,CommunityTransport}.swift "$out/source/"
cp apps/ios/RightSide/Sensors/{SensorEvidence,VehicleEvidence,CameraGuidanceModels}.swift "$out/source/"
cp apps/ios/RightSideTests/GuidanceTests.swift scripts/check-workstream-A-guidance.swift "$out/"
common=(-target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors)
xcrun swiftc "${common[@]}" -emit-library -emit-module -enable-testing -module-name RightSide "$out/source/"*.swift \
 -emit-module-path "$out/RightSide.swiftmodule" -o "$out/libRightSide.dylib"
cp apps/ios/RightSide/Resources/{domain.js,bern-demo.json} "$out/"
xcrun swiftc "${common[@]}" -F "$frameworks" -I "$libraries" -L "$libraries" -I "$out" -L "$out" -lRightSide \
 -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" -Xlinker -rpath -Xlinker "$out" \
 "$out/GuidanceTests.swift" "$out/check-workstream-A-guidance.swift" -o "$out/guidance-checks"
"$out/guidance-checks"
