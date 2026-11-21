#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
if [[ "$(uname -s)" != "Darwin" ]]; then echo "iOS compilation requires macOS and full Xcode." >&2; exit 1; fi
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcodebuild -version
project=apps/ios/RightSide.xcodeproj
destination=dist/ios/DerivedData
case "${1:-simulator}" in
  simulator)
    xcodebuild -project "$project" -scheme RightSide -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath "$destination" CODE_SIGNING_ALLOWED=NO build
    echo "Simulator app: $root/$destination/Build/Products/Debug-iphonesimulator/RightSide.app"
    ;;
  device)
    xcodebuild -project "$project" -scheme RightSide -configuration Release -destination 'generic/platform=iOS' -derivedDataPath "$destination" CODE_SIGNING_ALLOWED=NO build
    mkdir -p dist/ios
    stage="$(mktemp -d "$root/dist/ios/ipa.XXXXXX")"
    mkdir "$stage/Payload"
    ditto "$destination/Build/Products/Release-iphoneos/RightSide.app" "$stage/Payload/RightSide.app"
    ditto -c -k --keepParent "$stage/Payload" "$root/dist/ios/RightSide-unsigned.ipa"
    echo "Unsigned device IPA: $root/dist/ios/RightSide-unsigned.ipa (requires signing before installation)"
    ;;
  test)
    if [[ -z "${IOS_TEST_DESTINATION:-}" ]]; then echo "Set IOS_TEST_DESTINATION to a simulator destination reported by Xcode/device tooling." >&2; exit 1; fi
    xcodebuild -project "$project" -scheme RightSide -configuration Debug -destination "$IOS_TEST_DESTINATION" -derivedDataPath "$destination" CODE_SIGNING_ALLOWED=NO test
    ;;
  *) echo "Usage: bash scripts/build-ios.sh [simulator|device|test]" >&2; exit 1 ;;
esac
