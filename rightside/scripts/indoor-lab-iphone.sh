#!/bin/bash
# Bounded, manual indoor research workflow. Never launches/resets the app or starts a simulator.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
delivery="$root/dist/ios/indoor-lab"
device=00008140-000931A011D3001C
mkdir -p "$delivery"
case "${1:-help}" in
  stage)
    xcrun devicectl list devices --timeout 20 --json-output "$delivery/devices-stage.json"
    test -f "$delivery/IndoorLab/manifest.json"
    xcrun devicectl device copy to --device "$device" --source "$delivery/IndoorLab" \
      --destination Documents/IndoorLab --domain-type appDataContainer --domain-identifier org.rightside.journey \
      --timeout 60 --json-output "$delivery/stage-$(date -u +%Y%m%dT%H%M%SZ).json"
    ;;
  results|reference-results)
    source_file=latest-report.json
    if [ "$1" = reference-results ]; then source_file=automatic-reference-report.json; fi
    run="$delivery/$1-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir "$run"
    xcrun devicectl device copy from --device "$device" --source "Documents/IndoorLab/$source_file" \
      --destination "$run/report.json" --domain-type appDataContainer --domain-identifier org.rightside.journey \
      --timeout 30 --json-output "$run/copy.json"
    echo "Phone report: $run/report.json"
    ;;
  install)
    test -n "${2:-}" || { echo 'Supply the signed app path.' >&2; exit 2; }
    bash "$root/scripts/ar-iphone.sh" install "$2"
    ;;
  *) echo 'Usage: indoor-lab-iphone.sh stage | results | reference-results | install SIGNED_APP'
     echo 'Build current source serially using scripts/ar-iphone.sh build.' ;;
esac
