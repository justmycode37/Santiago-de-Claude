#!/usr/bin/env python3
"""Stage only after granted native Swift tensor/pixel parity; manager registers Xcode files."""
import argparse,hashlib,json,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('native_report',type=Path);a=p.parse_args()
root=Path(__file__).resolve().parents[1]
assert not json.loads((root.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
r=json.loads(a.native_report.read_text());assert r['checks']==26 and r['failures']==0
assert len(r['pixelRows'])==12 and all(x['passed'] and x['inputMaxError']==0 and x['channelOrientationMaxError']==0 for x in r['pixelRows'])
source=root/'dist/hill-climb-b3/conversion.zhizqi_c'
inventory=json.loads((source/'artifact-sha256.json').read_text())
for name,entry in inventory.items():assert hashlib.sha256((source/name).read_bytes()).hexdigest()==entry['sha256']
dest=root/'apps/ios/RightSide/Resources/VehicleDisplayRecognition/v1';dest.mkdir(parents=True,exist_ok=True)
package='VehicleDisplayRecognizer.mlpackage'
assert not (dest/package).exists(),'Do not silently overwrite a staged version'
shutil.copytree(source/package,dest/package)
shutil.copyfile(source/'display-characters.json',dest/'display-characters.json')
assets=root/'dist/hill-climb-b3/paddle-assets'
license_path=next(x for x in assets.iterdir() if x.is_file() and 'LICENSE' in x.name)
shutil.copyfile(license_path,dest/'DisplayRecognition-Apache-2.0.txt')
(dest/'NOTICE.txt').write_text('''Vehicle display recognition v1\nPaddlePaddle latin_PP-OCRv5_mobile_rec model, Apache-2.0.\nOriginal model revision89d3a50e2c27e2e7cceeab0e944c25c807d5db4f.\nhttps://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx\nSame weights converted locally ONNX→Torch→FLOAT32 CoreML; fixed1x3x48x320 CPU.\n\nResize arithmetic adapted to bounded scalarSwift from KleidiCV26.09:\nCopyright2026 Arm Limited and/or its affiliates <open-source-office@arm.com>\nApache-2.0; modifications: Swift scalar implementation, bounded buffers, no SIMD overreads.\nhttps://gitlab.arm.com/kleidi/kleidicv/-/blob/26.09/kleidicv/src/resize/resize_linear_generic_u8_neon.h\n\nDEVELOPMENT evidence only. Raw character scores are not calibrated service probability.\nNo expected route words, remote inference or authoritative vehicle-trip binding.\n''')
manifest={'version':1,'originalModelSHA256':'7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498','originalRevision':'89d3a50e2c27e2e7cceeab0e944c25c807d5db4f','license':'Apache-2.0','modelConversionReportSHA256':hashlib.sha256((source/'parity.json').read_bytes()).hexdigest(),'nativeReport':str(a.native_report.resolve()),'nativeReportSHA256':hashlib.sha256(a.native_report.read_bytes()).hexdigest(),'input':'BGR uint8→KleidiCV26.09-compatible two-stage integer linear48px→/127.5-1→CHW zero pad320','decode':'greedy CTC blank0,first argmax tie,collapse repeats before blank removal','computeUnits':'CPU_ONLY','shape':[1,3,48,320],'independentPhotos':2,'fieldValidation':False,'files':{str(p.relative_to(dest)):hashlib.sha256(p.read_bytes()).hexdigest() for p in dest.rglob('*') if p.is_file()}}
(dest/'display-model-manifest.json').write_text(json.dumps(manifest,indent=2));print(dest)
