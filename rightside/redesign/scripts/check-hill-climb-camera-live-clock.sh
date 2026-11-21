#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import json; assert not json.load(open("../docs/hill-climb/STATE.json"))["stopRequested"], "Hill climb stopped"'
# Reuse a declared immutable replay binary/model snapshot. No compiler runs in this measurement.
checkpoint=${1:?Pass absolute or repository-relative recorded replay output directory}
out=$(mktemp -d "$(pwd)/dist/hill-climb-m3/actual-time.XXXXXX")
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\nCheckpoint: %s\n' "$out" "$checkpoint"
cp "$checkpoint/"{source-sha256.txt,image-sources.json,model-manifest.json} "$out/"
sysctl hw.model hw.memsize hw.ncpu vm.swapusage > "$out/resources-before.txt"
ps -axo pid,ppid,etime,%cpu,rss,comm | rg 'swift|clang|recorded-checks' >> "$out/resources-before.txt" || true
python3 - "$checkpoint/recorded-checks" "$checkpoint/TransportSegmenter.mlmodelc" "$(pwd)/evaluation/images" "$out" "${2:-live-clock}" <<'PYRUN'
import subprocess, sys
subprocess.run(sys.argv[1:], check=True, timeout=300)
PYRUN
sysctl hw.model hw.memsize hw.ncpu vm.swapusage > "$out/resources-after.txt"
