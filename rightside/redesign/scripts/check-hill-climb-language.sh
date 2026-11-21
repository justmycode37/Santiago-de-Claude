#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/hill-climb-m2
out=$(mktemp -d "$(pwd)/dist/hill-climb-m2/manager-check.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
xcrun swiftc -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
  -D HILL_CLIMB_LANGUAGE_HARNESS -F "$frameworks" -I "$libraries" -L "$libraries" \
  -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" \
  apps/ios/RightSide/UI/JourneyLanguage.swift \
  apps/ios/RightSideTests/JourneyLanguageTests.swift \
  scripts/check-hill-climb-language.swift -o "$out/language-checks"
token="language-$(basename "$out")"
"$out/language-checks" --ui-testing "$token"
for language in de fr en; do
  "$out/language-checks" --ui-testing "$token" --write-language "$language"
  "$out/language-checks" --ui-testing "$token" --expect-language "$language"
done
