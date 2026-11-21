#!/usr/bin/env python3
"""Refresh generated project's Swift references without requiring a Node installation."""
import hashlib
import argparse
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1] / 'apps/ios'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', action='append', help='Register only this iOS-root-relative Swift file; repeat for a stable integration slice.')
args = parser.parse_args()
selected = set(args.source or [])
for relative in selected:
    candidate = root / relative
    if not candidate.is_file() or candidate.suffix != '.swift' or candidate.resolve().is_relative_to(root.resolve()) is False:
        parser.error('Source must be an existing Swift file inside apps/ios: ' + relative)
path = root / 'RightSide.xcodeproj/project.pbxproj'
project = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(path)]))
objects = project['objects']
def key(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24].upper()
for target in ['RightSide', 'RightSideTests', 'RightSideUITests']:
    group = objects[key(target + ':group')]['children']
    phase = objects[key(target + ':Sources')]['files']
    for source in sorted((root / target).rglob('*.swift')):
        relative = str(source.relative_to(root))
        if selected and relative not in selected: continue
        ref = key('file:' + relative)
        build = key(target + ':build:' + relative)
        objects[ref] = dict(isa='PBXFileReference', lastKnownFileType='sourcecode.swift', path=relative, sourceTree='<group>')
        objects[build] = dict(isa='PBXBuildFile', fileRef=ref)
        if ref not in group: group.append(ref)
        if build not in phase: phase.append(build)
# Model packages are compiled by Xcode; a folder reference preserves versioned pack paths.
for relative, filetype in [('RightSide/Resources/TransportSegmenter.mlpackage', 'folder.mlpackage'),
                           ('RightSide/Resources/TransportPacks', 'folder'),
                           ('RightSide/Resources/SpatialPacks', 'folder'),
                           ('RightSide/Resources/TransitGeometry', 'folder'),
                           ('RightSide/Resources/VehicleDisplayRecognition/v1/VehicleDisplayRecognizer.mlpackage', 'folder.mlpackage'),
                           ('RightSide/Resources/VehicleDisplayRecognition/v1/display-characters.json', 'text.json'),
                           ('RightSide/Resources/VehicleDisplayRecognition/v1/DisplayRecognition-Apache-2.0.txt', 'text'),
                           ('RightSide/Resources/VehicleDisplayRecognition/v1/NOTICE.txt', 'text'),
                           ('RightSide/Resources/VehicleDisplayRecognition/v1/display-model-manifest.json', 'text.json')]:
    if not (root / relative).exists(): continue
    ref, build = key('file:' + relative), key('RightSide:build:' + relative)
    objects[ref] = dict(isa='PBXFileReference', lastKnownFileType=filetype, path=relative, sourceTree='<group>')
    objects[build] = dict(isa='PBXBuildFile', fileRef=ref)
    group = objects[key('RightSide:group')]['children']
    phase = objects[key('RightSide:Resources')]['files']
    if ref not in group: group.append(ref)
    if build not in phase: phase.append(build)
# Public retained OJP responses belong to the test bundle only.
relative = 'RightSideTests/Fixtures/OJP'
if (root / relative).is_dir():
    ref, build = key('file:' + relative), key('RightSideTests:build:' + relative)
    objects[ref] = dict(isa='PBXFileReference', lastKnownFileType='folder', path=relative, sourceTree='<group>')
    objects[build] = dict(isa='PBXBuildFile', fileRef=ref)
    group = objects[key('RightSideTests:group')]['children']
    phase = objects[key('RightSideTests:Resources')]['files']
    if ref not in group: group.append(ref)
    if build not in phase: phase.append(build)

def plist(value, depth=0):
    if isinstance(value, dict):
        return '{\n' + ''.join('\t' * (depth + 1) + json.dumps(k) + ' = ' + plist(v, depth + 1) + ';\n' for k, v in value.items()) + '\t' * depth + '}'
    if isinstance(value, list): return '(' + ', '.join(plist(v, depth + 1) for v in value) + ')'
    return json.dumps(str(value))
path.write_text('// !$*UTF8*$!\n' + plist(project) + '\n')
