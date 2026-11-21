#!/usr/bin/env python3
"""Build an ARKit image-anchor site directory from explicit survey + independent checkpoints.
No coordinate/width/floor inference. Only normalized PNGs with orientation baked into pixels.
Synthetic evidence is retained as synthetic and cannot activate native field guidance.
"""
import argparse,hashlib,json,math,shutil,struct
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def sha(b):return hashlib.sha256(b).hexdigest()
def png_size(path):
 data=path.read_bytes()
 if len(data)>2_000_000 or data[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError('Require normalized PNG <=2 MB')
 w,h=struct.unpack('>II',data[16:24]);pos=8
 while pos+12<=len(data):
  size=struct.unpack('>I',data[pos:pos+4])[0];kind=data[pos+4:pos+8]
  if kind==b'eXIf':raise ValueError('Bake image orientation into pixels; EXIF is not accepted')
  pos+=size+12
 if not(64<=w<=2048 and 64<=h<=2048):raise ValueError('Image dimensions outside AR reference limits')
 return data,w,h

def main():
 p=argparse.ArgumentParser();p.add_argument('survey',type=Path);p.add_argument('checkpoints',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
 if json.loads((ROOT.parent/'docs/hill-climb/STATE.json').read_text()).get('stopRequested'):raise SystemExit('STOP REQUESTED')
 raw=a.survey.read_bytes();survey=json.loads(raw);checksRaw=a.checkpoints.read_bytes();checks=json.loads(checksRaw)
 if checks['evidenceKind'] not in ['synthetic_known_geometry','independent_field_checkpoints']:raise ValueError('Declare evidence type')
 if checks['referenceSurveySHA256']!=sha(raw):raise ValueError('Checkpoint protocol references another survey snapshot')
 if checks['usedForReferenceFitting']:raise ValueError('Evaluation checkpoints must be held out of reference fitting')
 required=['siteID','version','source','license','surveyedAt','expiresAt','originLatitude','originLongitude','landmarkSurveyErrorMeters','validationDeviceModels','maximumViewDistanceMeters','landmarks','areas']
 for key in required:
  if key not in survey:raise ValueError('Missing '+key)
 records=checks['checkpoints']
 if len(records)<20 or len({r['id'] for r in records})!=len(records):raise ValueError('Need >=20 distinct independent checkpoints')
 errors=[];vertical=[];angles=[];registration=[]
 for r in records:
  expected=r['truthCameraENU'];estimated=r['estimatedCameraENU']
  if len(expected)!=3 or len(estimated)!=3:raise ValueError('Camera ENU coordinates required')
  if not all(math.isfinite(float(v)) for v in expected+estimated):raise ValueError('Nonfinite checkpoint')
  errors.append(math.dist(expected[:2],estimated[:2]));vertical.append(abs(expected[2]-estimated[2]))
  angles.append(abs((r['estimatedHeadingDegrees']-r['truthHeadingDegrees']+180)%360-180))
  registration.append(r['heldOutRegistrationErrorPixels'])
 if not all(math.isfinite(float(v)) and v>=0 for v in registration):raise ValueError('Bad registration errors')
 pack={key:survey[key] for key in required};pack['schemaVersion']=2;pack['checkpointErrorsMeters']=errors
 pack['validation']={'evidenceKind':checks['evidenceKind'],'checkpointDatasetSHA256':sha(checksRaw),'referenceSurveySHA256':sha(raw),'independentCheckpointCount':len(records),'headingErrorsDegrees':angles,'verticalErrorsMeters':vertical,'registrationErrorsPixels':registration,'referenceFrame':'ENU_meters_camera_right_up_back','cameraCalibration':'ARKit_per_frame_intrinsics'}
 a.output.mkdir(parents=True,exist_ok=True);pixels=0;digests=set()
 for landmark in pack['landmarks']:
  name=landmark['imageFile']
  if Path(name).name!=name or '..' in name:raise ValueError('Unsafe reference filename')
  data,w,h=png_size(a.survey.parent/name);pixels+=w*h
  digest=sha(data)
  if digest in digests:raise ValueError('Duplicate image reference')
  if landmark.get('imageSHA256')!=digest:raise ValueError('Survey must pin the original reference-image SHA256')
  digests.add(digest)
  if landmark.get('pixelWidth')!=w or landmark.get('pixelHeight')!=h:raise ValueError('Survey pixel dimensions must match normalized reference')
  if not(0.1<=landmark['physicalWidthMeters']<=5):raise ValueError('Measured physical width required')
  if len(landmark['siteFromImage'])!=16 or not all(math.isfinite(float(v)) for v in landmark['siteFromImage']):raise ValueError('Measured rigid reference transform required')
  landmark['imageSHA256']=digest;(a.output/name).write_bytes(data)
 if pixels>16_000_000:raise ValueError('Reference pixel budget exceeded')
 for area in pack['areas']:
  if not area.get('level') or 'floorHeightMeters' not in area:raise ValueError('Unknown floors cannot become field area claims')
 (a.output/'site.json').write_text(json.dumps(pack,indent=2)+'\n')
 shutil.copyfile(a.survey,a.output/'survey-provenance.json');shutil.copyfile(a.checkpoints,a.output/'checkpoint-provenance.json')
 print(json.dumps({'evidence':checks['evidenceKind'],'checkpointCount':len(records),'maxHorizontalMeters':max(errors),'maxVerticalMeters':max(vertical),'maxHeadingDegrees':max(angles),'maxRegistrationPixels':max(registration),'nativeImportRequired':True,'checkpointThresholdsPassed':checks['evidenceKind']=='independent_field_checkpoints' and max(errors)+pack['landmarkSurveyErrorMeters']<=1 and max(angles)<=3 and max(registration)<=8 and max(vertical)+pack['landmarkSurveyErrorMeters']<=0.5},indent=2))
if __name__=='__main__':main()
