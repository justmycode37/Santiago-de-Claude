#!/usr/bin/env python3
"""Add a diagnostic pixel manifest to an existing surveyed-reference directory.
Never creates field validation or changes the survey. PNG inputs only; native importer
independently rechecks original image hashes, dimensions, transforms and field proof.
"""
import pathlib,json,hashlib,struct,re,sys
root=pathlib.Path(__file__).resolve().parents[1]
assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
if len(sys.argv)!=2:raise SystemExit('Usage: prepare-visual-reference-pack.py EXISTING_SITE_DIRECTORY')
directory=pathlib.Path(sys.argv[1]).resolve();sitePath=directory/'site.json'
if sitePath.stat().st_size>500000:raise ValueError('site exceeds budget')
site=json.loads(sitePath.read_text());refs=[]
if not 2<=len(site['landmarks'])<=8:raise ValueError('2–8 distinct references required')
for original in site['landmarks']:
 name=original['imageFile'];path=directory/name
 if path.resolve().parent!=directory or pathlib.Path(name).name!=name or path.stat().st_size>2000000:raise ValueError('reference path/size rejected')
 data=path.read_bytes()
 if hashlib.sha256(data).hexdigest()!=original['imageSHA256']:raise ValueError('existing survey image hash mismatch')
 if data[:8]!=b'\x89PNG\r\n\x1a\n' or data[12:16]!=b'IHDR':raise ValueError('authoring tool requires upright PNG; native importer also supports ImageIO formats')
 width,height=struct.unpack('>II',data[16:24])
 if not 64<=width<=2048 or not 64<=height<=2048:raise ValueError('reference dimensions rejected')
 a=original['siteFromImage']
 if len(a)!=16:raise ValueError('surveyed AR image transform missing')
 # Fixed AR image-anchor XZ to centered upright physical XY plane: Rx(-pi/2).
 plane=a[0:4]+[-x for x in a[8:12]]+a[4:8]+a[12:16]
 physical=original['physicalWidthMeters']
 refs.append({'imageSHA256':original['imageSHA256'],'plane':{'id':original['id'],'widthMeters':physical,'heightMeters':physical*height/width,'siteFromPlane':plane}})
config=re.search(r'static let configurationID = "([^"]+)"',(root/'apps/ios/RightSide/Spatial/VisualReferenceMatcher.swift').read_text()).group(1)
manifest={'schemaVersion':1,'siteID':site['siteID'],'siteVersion':site['version'],'detectorConfiguration':config,'planeConvention':'centered_X_right_Y_up_Z_out_meters','references':refs}
output=directory/'pixel-references.json';output.write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
print(json.dumps({'manifest':str(output),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'geographicActivation':False,'note':'Diagnostic manifest only. Does not generate/certify independent detector-specific field evidence.'}))
