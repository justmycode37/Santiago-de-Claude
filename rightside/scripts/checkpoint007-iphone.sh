#!/bin/bash
# Frozen checkpoint007 delivery. Never uninstalls, launches, or resets a device.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
delivery="$root/dist/ios/checkpoint007-device"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
mode="${1:-install}"
device=00008140-000931A011D3001C
app="$delivery/RightSide.xcarchive/Products/Applications/RightSide.app"

case "$mode" in
  build)
    python3 - "$delivery" <<'PY'
import hashlib, json, sys
from pathlib import Path
delivery = Path(sys.argv[1])
expected = json.loads((delivery / 'source-manifest.json').read_text())
base = delivery / 'ios'
actual = {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in base.rglob('*') if p.is_file()
          and not any(x in p.relative_to(base).parts for x in
                      ['.DS_Store', 'xcuserdata', 'build', 'DerivedData'])}
if actual != expected:
    raise SystemExit('Frozen source differs from checkpoint007; refusing rebuild.')
print(f'Verified {len(expected)} checkpoint007 files.')
PY
    run="$delivery/rebuild-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir "$run"
    # Existing automatic signing setup; Xcode may renew the personal profile.
    xcodebuild -jobs 2 -project "$delivery/ios/RightSide.xcodeproj" \
      -scheme RightSide -configuration Debug -sdk iphoneos \
      -destination 'generic/platform=iOS' -derivedDataPath "$run/DerivedData" \
      -archivePath "$run/RightSide.xcarchive" -resultBundlePath "$run/Archive.xcresult" \
      -allowProvisioningUpdates DEVELOPMENT_TEAM=7A8T369F52 \
      CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' \
      ARCHS=arm64 ONLY_ACTIVE_ARCH=YES archive 2>&1 | tee "$run/archive.log"
    app="$run/RightSide.xcarchive/Products/Applications/RightSide.app"
    codesign --verify --deep --strict --verbose=2 "$app"
    echo "Signed archive: $run/RightSide.xcarchive"
    echo "Install: bash '$0' install '$app'"
    exit 0
    ;;
  install)
    app="${2:-$app}"
    ;;
  *) echo "Usage: $0 [build | install [signed-app-path]]" >&2; exit 2 ;;
esac

codesign --verify --deep --strict --verbose=2 "$app"
python3 - "$app" "$device" <<'PY'
import datetime, plistlib, subprocess, sys
from pathlib import Path
app, device = Path(sys.argv[1]), sys.argv[2]
info = plistlib.loads((app / 'Info.plist').read_bytes())
profile = plistlib.loads(subprocess.check_output(
    ['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
entitlements = plistlib.loads(subprocess.check_output(
    ['codesign', '-d', '--entitlements', ':-', str(app)], stderr=subprocess.DEVNULL))
assert info['CFBundleIdentifier'] == 'org.rightside.journey', 'Wrong bundle identity'
assert info['DTPlatformName'] == 'iphoneos', 'Not a physical iPhone build'
assert profile['TeamIdentifier'] == ['7A8T369F52'], 'Wrong signing team'
assert entitlements['application-identifier'] == '7A8T369F52.org.rightside.journey'
assert device in profile['ProvisionedDevices'], 'Phone missing from provisioning profile'
assert profile['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), \
    'Profile expired. Run build to renew signing, then install the new app path.'
print('Bundle identity, device provisioning and profile expiry verified.')
PY
run="$delivery/install-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$run"
# A normal same-identity update preserves the existing application data container.
xcrun devicectl device install app --device "$device" "$app" --timeout 60 \
  --json-output "$run/install.json" --log-output "$run/install.log"
xcrun devicectl device info apps --device "$device" --timeout 30 \
  --filter "bundleIdentifier == 'org.rightside.journey'" \
  --json-output "$run/installed-app.json" --log-output "$run/installed-app.log"
echo "Install commands completed. Open RightSide manually on your iPhone. Logs: $run"
