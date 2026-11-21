#!/usr/bin/env python3
import json,math,pathlib,sys,statistics
root=pathlib.Path(sys.argv[1]);rows=[json.loads(x)for x in pathlib.Path(sys.argv[2]).read_text().splitlines()if x.startswith('{')]
def project(h,x,y):
 z=h[2][0]*x+h[2][1]*y+h[2][2];return [(h[0][0]*x+h[0][1]*y+h[0][2])/z,(h[1][0]*x+h[1][1]*y+h[1][2])/z]
for row in rows:
 h=[[float(x)for x in line.split()]for line in (root/('H_1_'+row['id'])).read_text().splitlines()if line.strip()]
 rw,rh=row['referenceOriginalSize'];cw,ch=row['cameraOriginalSize'];width,height=row['normalizedSize']
 for key in ['H','refinedH']:
  if key not in row:continue
  matrix=[[row[key][col*3+r]for col in range(3)]for r in range(3)];errors=[]
  for y in [.1,.3,.5,.7,.9]:
   for x in [.1,.3,.5,.7,.9]:
    truth=project(h,x*rw,y*rh);truth=[truth[0]*width/cw,truth[1]*height/ch];estimate=project(matrix,x*width,y*height)
    errors.append(math.dist(truth,estimate))
  row[key+'PointMedianPixels']=statistics.median(errors);row[key+'PointP95Pixels']=sorted(errors)[math.ceil(.95*len(errors))-1];row[key+'PointMaximumPixels']=max(errors)
summary={'dataset':'HPatches v_busstop','evidenceKind':'post_exposure_real_capture_regression' if '--development'in sys.argv else 'independent_real_captures_homography_only','positivePairs':2,'accepted':sum(r['accepted']for r in rows),'metricOrFieldAccuracyClaim':False,'rows':rows,'calibrationAndPhysicalDimensions':'not supplied; metric pose not estimated','algorithmFrozenBeforeCaptureAcquisition':'--development'not in sys.argv}
summary['acceptedBeyondFivePixels']=sum(r['accepted'] and r.get('HPointMaximumPixels',float('inf'))>5 for r in rows)
summary['utilityGatePassed']=summary['accepted']>=1 and summary['acceptedBeyondFivePixels']==0 and len(rows)==2
pathlib.Path(sys.argv[3]).write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))

raise SystemExit(0 if summary['utilityGatePassed'] else 2)
