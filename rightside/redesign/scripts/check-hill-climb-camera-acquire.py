#!/usr/bin/env python3
"""Bounded optional acquisition. A rate limit stops this run; it is never retried in a loop."""
import hashlib
import json
from pathlib import Path
import urllib.request
import urllib.error
root = Path(__file__).resolve().parent.parent
assert not json.loads((root.parent / 'docs/hill-climb/STATE.json').read_text())['stopRequested']
folder = root / 'evaluation/camera-holdout'
manifest = json.loads((folder / 'sources.json').read_text())
receipts = []
for item in manifest['sources']:
    path = folder / (item['id'] + '.jpg')
    if path.exists():
        data = path.read_bytes()
    else:
        request = urllib.request.Request(item['imageURL'], headers={'User-Agent': 'RightSideLocalEvaluation/1.0 (local research)'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read(12_000_001)
        except urllib.error.HTTPError as error:
            (folder / 'acquisition-result.json').write_text(json.dumps({'error': str(error), 'source': item['source'], 'downloaded': receipts}, indent=2))
            raise SystemExit(str(error) + '; stopped without retry')
    assert len(data) <= 12_000_000 and hashlib.sha1(data).hexdigest() == item['expectedSHA1'], 'Unexpected image bytes'
    path.write_bytes(data)
    receipts.append({'id': item['id'], 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
(folder / 'acquisition-result.json').write_text(json.dumps({'downloaded': receipts}, indent=2))
print(json.dumps(receipts, indent=2))
