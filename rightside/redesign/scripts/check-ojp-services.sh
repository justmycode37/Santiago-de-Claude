#!/bin/bash
set -euo pipefail
cd "${A5_ROOT:-$(dirname "$0")/..}"
python3 ../docs/hill-climb/execution_guard.py A5
if [[ "${A5_OWNED_CHECK:-0}" != 1 ]]; then
    exec python3 - "$0" <<'PYBOUND'
import datetime,json,os,pathlib,signal,subprocess,sys,tempfile,time
root=pathlib.Path.cwd(); base=root/'dist/workstream-A5';base.mkdir(parents=True,exist_ok=True)
out=pathlib.Path(tempfile.mkdtemp(prefix='checks.',dir=base))
start=time.monotonic(); began=datetime.datetime.now(datetime.timezone.utc).isoformat()
launcher=out/'immutable-runner.sh';launcher.write_bytes(pathlib.Path(sys.argv[1]).read_bytes())
env=dict(os.environ,A5_OWNED_CHECK='1',A5_CHECK_OUTPUT=str(out),A5_ROOT=str(root))
process=subprocess.Popen(['bash',str(launcher)],env=env,start_new_session=True)
timedout=False
try: code=process.wait(timeout=300)
except subprocess.TimeoutExpired:
 timedout=True;os.killpg(process.pid,signal.SIGTERM)
 try:process.wait(timeout=5)
 except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
 code=124
(out/'compute.json').write_text(json.dumps({'startedAt':began,'elapsedSeconds':time.monotonic()-start,'limitSeconds':300,'exitCode':code,'timedOut':timedout,'ownedProcessGroup':process.pid,'network':'disabled in test logic; fixture-only'},indent=2))
sys.exit(code)
PYBOUND
fi
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
frameworks="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libraries="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib"
mkdir -p dist/workstream-A5
out="$A5_CHECK_OUTPUT"
exec > >(tee "$out/check.log") 2>&1
printf 'Output: %s\n' "$out"
mkdir -p "$out/source/RightSide/UI" "$out/source/RightSide/Sensors" "$out/source/scripts"
cp -cR apps/ios/RightSide/Core "$out/source/RightSide/Core"
cp -cR apps/ios/RightSideTests "$out/source/RightSideTests"
cp -cR apps/ios/RightSide/UI/. "$out/source/RightSide/UI/"
cp apps/ios/RightSide/Sensors/SensorEvidence.swift "$out/source/RightSide/Sensors/"
cp scripts/check-hill-climb-recovery-location.swift scripts/check-ojp-services.swift scripts/check-ojp-services-process.swift scripts/check-stop-departures-process.swift "$out/source/scripts/"
cp -cR apps/ios/RightSide/Resources/TransitGeometry "$out/TransitGeometry"
cp dist/workstream-A3/sources-20261121T051756426003Z/planner.json "$out/a3-planner.json"
cp dist/workstream-A3/sources-20261121T051756426003Z/planner-provenance.json "$out/a3-planner-provenance.json"
cp -cR dist/workstream-A4/sources-20261121T061512797359Z "$out/a4-provider"
cp -cR dist/workstream-A4/handoff-20261121T062150807014Z "$out/a4-handoff"
cp -cR apps/ios/RightSideTests/Fixtures/OJP "$out/a5-provider"
cp apps/ios/RightSide/Resources/{domain.js,bern-demo.json} "$out/"
cp scripts/check-ojp-services.sh "$out/source/scripts/"
python3 - "$out" <<'PYHASH'
import sys,pathlib,hashlib,json
root=pathlib.Path(sys.argv[1]);files=[p for p in root.rglob('*') if p.is_file() and p.name!='check.log']
(root/'input-manifest.json').write_text(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2))
PYHASH
common=(-target arm64-apple-macos14.0 -swift-version 5 -strict-concurrency=complete -warnings-as-errors)
xcrun swiftc "${common[@]}" -emit-library -emit-module -enable-testing -module-name RightSide \
 "$out/source/RightSide/Core/"{JSONValue,DTOs,DomainBridge,JourneyCache,NavigationGuidance,StopDepartures,JourneyReminders,MapServices,WalkingBundle,CommunityTransport,JourneyStore,StopDepartureTransport,StopDepartureController,TransitGeometry,TransitGeometryRepository,TransitGeometryController,OJPXML,OJPModels,OJPDecoder,OJPTransport,OJPJourneyAdapter,OJPServiceUpdate}.swift \
 "$out/source/RightSide/UI/JourneyLanguage.swift" "$out/source/RightSide/UI/DeparturePresentation.swift" "$out/source/RightSide/Sensors/SensorEvidence.swift" "$out/source/scripts/check-hill-climb-recovery-location.swift" \
 -emit-module-path "$out/RightSide.swiftmodule" -o "$out/libRightSide.dylib"
xcrun swiftc "${common[@]}" -D HILL_CLIMB_RECOVERY_HARNESS \
 -F "$frameworks" -I "$libraries" -L "$libraries" -I "$out" -L "$out" -lRightSide \
 -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" -Xlinker -rpath -Xlinker "$out" \
 "$out/source/RightSideTests/"{JourneyStoreRegressionTests,DomainBridgeTests,NativeCoreTests,JourneyLanguageTests,NavigationGuidanceTests,WalkingBundleTests,TransitGeometryTests,StopDepartureTests,DeparturePresentationTests,OJPServiceTests}.swift \
 "$out/source/scripts/check-ojp-services.swift" -o "$out/navigation-checks"
A5_PROVIDER_FIXTURES="$out/a5-provider" A4_HANDOFF_FIXTURE="$out/a4-handoff" A4_PROVIDER_FIXTURES="$out/a4-provider" WALK_BUNDLE_ARTIFACT="$out/recording-three-leg-bundle.json" "$out/navigation-checks" --ui-testing "navigation-$(basename "$out")"

xcrun swiftc "${common[@]}" -parse-as-library -I "$out" -L "$out" -lRightSide -Xlinker -rpath -Xlinker "$out" \
 "$out/source/scripts/check-stop-departures-process.swift" -o "$out/departure-restart-check"
"$out/departure-restart-check" write "$out/restart-cache.json" "$out/restart-expected.json"
"$out/departure-restart-check" read "$out/restart-cache.json" "$out/restart-expected.json"

xcrun swiftc "${common[@]}" -parse-as-library -I "$out" -L "$out" -lRightSide -Xlinker -rpath -Xlinker "$out" \
 "$out/source/scripts/check-ojp-services-process.swift" -o "$out/ojp-restart-check"
"$out/ojp-restart-check" write "$out/a5-provider" "$out/ojp-restart-cache.json" "$out/ojp-restart-expected.json"
"$out/ojp-restart-check" read "$out/a5-provider" "$out/ojp-restart-cache.json" "$out/ojp-restart-expected.json"
