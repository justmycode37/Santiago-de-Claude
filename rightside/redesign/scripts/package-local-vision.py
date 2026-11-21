#!/usr/bin/env python3
"""Package the current source and an already-built unsigned app; never overwrite archives."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
app, output = args.app.resolve(), args.output.resolve()
if not (app / 'RightSide').is_file() or not (app / 'TransportSegmenter.mlmodelc').is_dir():
    raise SystemExit('Expected the built RightSide app with compiled model')
output.mkdir(parents=True, exist_ok=True)
archive = output / 'RightSide-local-vision-source.tar.gz'
ipa = output / 'RightSide-local-vision-unsigned.ipa'
if archive.exists() or ipa.exists():
    raise SystemExit('Archive already exists; choose a new versioned output directory')

files = [root / 'README.md']
for folder in ['apps', 'docs', 'scripts', 'evaluation']:
    files.extend(p for p in (root / folder).rglob('*') if p.is_file()
                 and not any(x in p.parts for x in ['xcuserdata', '__pycache__', '.DS_Store']))
files.extend((root / 'research').glob('*.py'))
files.append(root / 'research/requirements-vision.lock')
hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))}
with tarfile.open(archive, 'w:gz') as tar:
    for name in hashes:
        tar.add(root / name, arcname='redesign/' + name, recursive=False)
with tarfile.open(archive, 'r:gz') as tar:
    for name, expected in hashes.items():
        actual = hashlib.sha256(tar.extractfile('redesign/' + name).read()).hexdigest()
        if actual != expected:
            raise SystemExit('Source archive verification failed: ' + name)
with tempfile.TemporaryDirectory(prefix='rightside-ipa-') as stage:
    payload = Path(stage) / 'Payload'
    payload.mkdir()
    subprocess.run(['ditto', str(app), str(payload / 'RightSide.app')], check=True)
    subprocess.run(['ditto', '-c', '-k', '--keepParent', str(payload), str(ipa)], check=True)
(output / 'source-manifest.json').write_text(json.dumps(hashes, indent=2) + '\n')
checksums = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [archive, ipa, output / 'source-manifest.json']}
(output / 'SHA256SUMS').write_text(''.join(f'{value}  {name}\n' for name, value in checksums.items()))
print(json.dumps({'verifiedSourceFiles': len(hashes), 'artifacts': checksums}, indent=2))
