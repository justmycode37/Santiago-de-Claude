#!/usr/bin/env python3
"""Independent evaluator for actual-pixel two-reference replay; no inputs to estimation."""
import json,math,pathlib,sys,statistics
manifest=json.load(open(sys.argv[1]));log=pathlib.Path(sys.argv[2]);out=pathlib.Path(sys.argv[3]);truths={x['id']:x for x in manifest['scenes']}
def point(h,p):
 x,y=p;z=h[2]*x+h[5]*y+h[8];return [(h[0]*x+h[3]*y+h[6])/z,(h[1]*x+h[4]*y+h[7])/z]
def errors(pose,truth):
 a,b=math.atan2(-pose[8],-pose[9]),math.atan2(-truth[8],-truth[9])
 return {'horizontalMeters':math.hypot(pose[12]-truth[12],pose[13]-truth[13]),'verticalMeters':abs(pose[14]-truth[14]),'headingDegrees':abs(math.degrees(math.atan2(math.sin(a-b),math.cos(a-b))))}
rows=[];referenceRows=[]
for line in log.read_text().splitlines():
 if not line.startswith('{'):continue
 row=json.loads(line)
 if not row.get('scene'):continue
 truth=truths[row['id']]
 for match in row['matches']:
  match.update(errors(match['pose'],truth['truthPose']))
  distances=[math.dist(point(match['H'],p),point(truth['homographies'][match['id']],p))for p in [(71,83),(301,109),(587,193),(91,339),(439,353),(557,421)]]
  match['heldOutMaximumPixels']=max(distances);referenceRows.append(match)
 if 'pose'in row:row['fusedErrors']=errors(row['pose'],truth['truthPose'])
 rows.append(row)
result={'evidenceKind':manifest['evidenceKind'],'viewCount':len(manifest['scenes']),'referenceOpportunities':len(manifest['scenes'])*len(manifest['references']),'acceptedReferences':len(referenceRows),'reliableFrames':sum(r['state']=='reliable'for r in rows),'rows':rows,'fieldAccuracyClaim':False}
for key in ['horizontalMeters','verticalMeters','headingDegrees','heldOutMaximumPixels']:
 values=sorted(r[key]for r in referenceRows)
 if values:result[key]={'median':statistics.median(values),'p95':values[math.ceil(.95*len(values))-1]}
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k!='rows'},indent=2))
