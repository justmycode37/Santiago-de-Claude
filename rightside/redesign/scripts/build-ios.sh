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
output="${RIGHTSIDE_BUILD_OUTPUT:-dist/vision-v1}"
destination="$output/BuildDerivedData"
case "${1:-simulator}" in
  simulator)
    xcodebuild -project "$project" -scheme RightSide -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath "$destination" CODE_SIGNING_ALLOWED=NO build
    echo "Simulator app: $root/$destination/Build/Products/Debug-iphonesimulator/RightSide.app"
    ;;
  device)
    xcodebuild -project "$project" -scheme RightSide -configuration Release -destination 'generic/platform=iOS' -derivedDataPath "$destination" CODE_SIGNING_ALLOWED=NO build
    mkdir -p "$output"
    stage="$(mktemp -d "$output/ipa.XXXXXX")"
    mkdir "$stage/Payload"
    ditto "$destination/Build/Products/Release-iphoneos/RightSide.app" "$stage/Payload/RightSide.app"
    archive="$output/RightSide-local-vision-$(date +%Y%m%d-%H%M%S)-unsigned.ipa"
    ditto -c -k --keepParent "$stage/Payload" "$archive"
    echo "Unsigned device IPA: $archive (requires signing before installation)"
    ;;
  test)
    if [[ -z "${IOS_TEST_DESTINATION:-}" ]]; then echo "Set IOS_TEST_DESTINATION to a simulator destination reported by Xcode/device tooling." >&2; exit 1; fi
    # XCTest's runner template must be re-signed after Xcode assembles its bundle.
    # Simulator ad-hoc signing requires no Apple account or provisioning profile.
    xcodebuild -project "$project" -scheme RightSide -configuration Debug -destination "$IOS_TEST_DESTINATION" -derivedDataPath "$destination" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
    ;;
  *) echo "Usage: bash scripts/build-ios.sh [simulator|device|test]" >&2; exit 1 ;;
esac
