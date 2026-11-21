#!/usr/bin/env python3
"""Evaluation only. Ground truth never enters native matcher arguments/optimization."""
import json,math,pathlib,sys,statistics
fixture=pathlib.Path(sys.argv[1]);log=pathlib.Path(sys.argv[2]);out=pathlib.Path(sys.argv[3])
manifest=json.loads(fixture.read_text());rows=[json.loads(x)for x in log.read_text().splitlines()if x.startswith('{')]
rows=[r for r in rows if not r.get('scene') and not r.get('capture')]
cases={x['id']:x for x in manifest['cases']}
def point(h,x,y):
 z=h[2]*x+h[5]*y+h[8]
 return [(h[0]*x+h[3]*y+h[6])/z,(h[1]*x+h[4]*y+h[7])/z]
def project(pose,p):
 d=[p[i]-pose[12+i]for i in range(3)]
 q=[sum(pose[4*j+i]*d[i]for i in range(3))for j in range(3)]
 k=manifest['calibration'];return [k['fx']*q[0]/-q[2]+k['cx'],k['cy']-k['fy']*q[1]/-q[2]]
for row in rows:
 case=cases[row['id']]
 if 'homography'in case:
  # Nine spatially distributed held-out locations, not supplied to registration/refinement.
  for key in ['H','refinedH']:
   if key in row:
    errors=[]
    for u,v in [(71,83),(179,61),(301,109),(503,79),(587,193),(91,339),(241,401),(439,353),(557,421)]:
     a,b=point(case['homography'],u,v),point(row[key],u,v);errors.append(math.dist(a,b))
    row[key+'HeldOutMedianPixels']=statistics.median(errors);row[key+'HeldOutMaximumPixels']=max(errors)
  if 'pose'in row:
   a,b=case['truthPose'],row['pose'];row['horizontalMeters']=math.hypot(a[12]-b[12],a[13]-b[13]);row['verticalMeters']=abs(a[14]-b[14])
   trace=sum(a[c*4+r]*b[c*4+r]for c in range(3)for r in range(3));row['orientationDegrees']=math.degrees(math.acos(max(-1,min(1,(trace-1)/2))))
   va,vb=math.atan2(-a[8],-a[9]),math.atan2(-b[8],-b[9]);row['headingDegrees']=abs(math.degrees(math.atan2(math.sin(va-vb),math.cos(va-vb)))) if math.hypot(a[8],a[9])>.1 else None
positive=[r for r in rows if r['expectedMatch']];accepted=[r for r in positive if r['accepted']];negative=[r for r in rows if not r['expectedMatch']]
summary={'evidenceKind':manifest['evidenceKind'],'positiveCount':len(positive),'positiveAccepted':len(accepted),'negativeCount':len(negative),'falseAccepted':sum(r['accepted']for r in negative),'rows':rows,'fieldAccuracyClaim':False}
for key in ['horizontalMeters','verticalMeters','orientationDegrees','headingDegrees','HHeldOutMaximumPixels','seconds']:
 values=sorted(r[key]for r in accepted if r.get(key)is not None)
 if values:summary[key]={'median':statistics.median(values),'p95':values[math.ceil(.95*len(values))-1]}
out.write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:v for k,v in summary.items()if k!='rows'},indent=2))
