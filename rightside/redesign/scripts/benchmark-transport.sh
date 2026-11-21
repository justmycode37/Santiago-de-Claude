#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p dist/vision-v1
xcrun coremlcompiler compile apps/ios/RightSide/Resources/TransportSegmenter.mlpackage dist/vision-v1
xcrun swiftc -O -target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
  apps/ios/RightSide/Sensors/VehicleEvidence.swift apps/ios/RightSide/Sensors/TransportSegmenter.swift \
  scripts/benchmark-transport.swift -o dist/vision-v1/benchmark-transport
dist/vision-v1/benchmark-transport dist/vision-v1/TransportSegmenter.mlmodelc evaluation/images \
  "dist/vision-v1/benchmark-$(date -u +%Y%m%dT%H%M%SZ).json" "${1:-180}"
