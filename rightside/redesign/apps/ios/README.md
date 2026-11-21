# Isolated native redesign — 2026-11-21

This copy includes the journey UI, Apple Maps search/walking/3D and live camera changes described in [the implementation report](../../docs/IMPLEMENTATION.md). Current validation is in [the validation report](../../docs/VALIDATION.md). The historical records below describe the parent snapshot and must not be treated as tests of this redesign.

---

# RightSide native iOS

Native SwiftUI and MapKit client for iOS 17+, with local Apple Vision OCR and Core Location. The bundled JavaScriptCore engine executes the same validated journey reducer and replay used by Windows. This is not a WebView wrapper. Search calls the public HTTPS Transport API directly; Windows need not be running.

## Preparation and build

On the development PC, `npm run ios:source` bundles the shared logic and Bern fixtures, generates a dependency-free Xcode project, and creates `dist/RightSide-ios-source.tar.gz`. Transfer this archive locally to the Mac and extract it inside a dedicated project folder. The archive includes generated resources, so Node/npm is not required to compile it there.

On a Mac with full Xcode and iOS platform support installed:

```sh
bash scripts/build-ios.sh simulator
```

Open `apps/ios/RightSide.xcodeproj` for interactive Xcode use. Select the RightSide scheme and a simulator. For a physical iPhone, select your own signing team in Signing & Capabilities and choose the connected device. No developer credentials or provisioning profiles are stored in this project.

For a device IPA to sign with Sideloadly:

```sh
bash scripts/build-ios.sh device
```

This creates `dist/ios/RightSide-unsigned.ipa` only after a successful arm64 iOS build. It is not installable until signed. A simulator `.app` cannot be converted into an iPhone IPA. Sideloadly is an installation/signing fallback, not a replacement for the iOS SDK.

## Tests and actual status

Windows `npm test` passes 115 TypeScript tests, including ten generated-iOS-bundle tests with Node/DOM/network globals absent. The bundle completes all 26 Bern replay events, outbound/return arrivals, stable match and loss, unknown-trip refresh rejection, location uncertainty and local walking.

The Xcode project includes 20 unit tests and two UI tests. These cover Apple JavaScriptCore execution, native cache/DTO round trips, dates, sensor transforms and explicit journey progression. All app and test targets now compile under Xcode 27.2. The simulator app and unsigned arm64 device IPA build successfully. The 20 unit tests and two UI tests have not yet executed because the required simulator runtime is still downloading; see the successful-setup follow-up below. Signing, physical-device behavior and native performance are not yet validated.

`swift scripts/check-ios-domain.swift apps/ios/RightSide/Resources` can exercise the real Apple JavaScriptCore bridge using macOS Command Line Tools while Xcode downloads. This is separate from an iOS compilation.

On the linked Mac, Swift 6.1.2 initially selected macOS SDK 26.2, whose Swift 6.2 interfaces cannot be compiled by that toolchain. The installed matching SDK works without changing system settings:

```sh
swift -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk scripts/check-ios-domain.swift apps/ios/RightSide/Resources
```

This command passed on the Mac: 26 replay events, outbound/return arrivals, service match/loss and `de-CH` normalization. All 19 app/test Swift files passed frontend parsing; the project and Info.plist passed `plutil -lint`. The portable Core files (JSONValue, DTOs, DomainBridge, CommunityTransport and JourneyCache) and SensorEvidence also passed macOS Swift type checking with SDK 15.5. A temporary macOS harness also compiled and ran the actual native bridge/cache/DTO code: lossless DTO and cache round trips, invalid-state rejection without overwriting the saved state, evidence aging, and sensor payload/freshness/geometry checks passed. These checks do not compile SwiftUI/UIKit for iOS or run the hosted iOS test targets. `bash scripts/build-ios.sh simulator` remains blocked until full Xcode is installed (`xcodebuild` requires Xcode; the active developer directory is CommandLineTools).

## Implemented boundaries

- Search, options, explicit full-journey progress, transfers/return, correction, active-route-preserving replan, saved restore and labelled simulation.
- Native maps distinguish schematic geometry and passenger uncertainty. Unverified paths, waiting areas and levels remain unknown.
- Direct public HTTPS with bounded response size, timeouts, cancellation and provider retry delays. Unknown authoritative trip IDs remain null; exact live refresh is unavailable.
- One location owner and one system still-camera owner. Imported/frozen images use local Apple OCR and remain service-unconfirmed. Camera capture is explicit, with no recording/upload or microphone permission.
- Native segmentation is currently unavailable. The Windows ONNX model has not yet been converted or validated on iOS. No geographic AR, precise curb inference or background navigation claim.

Planning/review decisions and Mac build evidence will be updated after the SDK is available. Everything remains local; no project GitHub operations or external publication.

## Source review follow-up

The independent review prompted fixes for new-journey clock/offline isolation, empty/failed searches preserving active guidance, state-backed offline controls, cancelled boarding feedback, location request timeout and visible recovery, single-owner OCR work, copied photo-import bytes, test cache isolation, and generated test-target metadata. Native fixes and four new JourneyStore regressions await iOS compilation/hosted XCTest. The earlier Mac evidence above applies to the pre-review snapshot; the reviewed snapshot was revalidated as recorded below.

Six new portable regression tests pass across both transit adapters: through-running calls with partial endpoint times, nonunique endpoint abstention, cancelled boarding preservation, and correct final-walk classification. Manual demo progression disables scripted events until the demo is restarted, preventing sequence collisions. Reopened demos preserve manual progress and remain manual. Sensor freshness uses the domain's ten-second window and rejects future fixes.

Local iOS identifier strings remain lossless encoded context rather than compact hashes. They are not authoritative trip IDs or server-signed tokens. Native compiler/concurrency diagnostics and hardware permissions remain part of the first Xcode validation.

## Reviewed-source Mac validation (2026-11-21)

Input archive SHA-256: `4cff33ec505e576830bfc5d9ff8f7333975918dea7594d1ca9fe611b0f783b0d`. Verified before extraction; all 44 entries were regular files/directories with no absolute paths, parent traversal, links or special files. These are actual local Mac checks, not an iOS build claim.

One inspection found `/Applications/Xcode.app` absent, with Command Line Tools selected and Swift 6.1.2 installed. The download was left running and was not polled. Both `bash scripts/build-ios.sh simulator` and `bash scripts/build-ios.sh device` exited 1 at `xcodebuild -version`: “tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance”. No simulator app or unsigned IPA was produced. Device discovery reported Agent device access disabled; no device was opened or driven. First-launch setup, iOS SDK/runtime validation, 20 hosted unit tests, two UI tests and hardware permissions remain pending.

All Swift checks below explicitly selected `/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk`, avoiding the incompatible default 26.2 SDK without changing system settings.

- `swift -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk scripts/check-ios-domain.swift apps/ios/RightSide/Resources` passed with actual Apple JavaScriptCore: 26 replay events, outbound/return arrivals, service match/loss and `de-CH` normalization.
- `swiftc -frontend -parse -sdk <SDK15.5> <file>` passed for all 20 app/test Swift files after fixing an invalid `0x85` byte in the location progress label. The replacement is a UTF-8 ellipsis.
- `plutil -lint` passed for the project and app Info.plist. A structural check verified every app/unit/UI Swift source appears in its generated target's source phase, all source/resource references exist, and shared scheme XML parses. `bash -n scripts/build-ios.sh` passed.
- The six portable files (`JSONValue`, `DTOs`, `DomainBridge`, `CommunityTransport`, `JourneyCache`, `SensorEvidence`) passed `swiftc -typecheck -swift-version 5 -strict-concurrency=complete -warnings-as-errors`.
- All Core files, including the unchanged NSObject convenience-initializer signature and Store Combine subscriptions, plus the non-UI LocationController body passed `swiftc -emit-module` in both Swift 5 and Swift 6 language modes with `-strict-concurrency=complete -warnings-as-errors`. This check used actual macOS CoreLocation and Combine, with only a temporary UIApplication shim and the SwiftUI location views excluded. It is not a complete UIKit/iOS typecheck.
- The extracted OCR worker body and ImageIO import preparation passed Swift 6 complete-concurrency module compilation with warnings treated as errors, using actual Vision, ImageIO and Dispatch APIs. UIKit camera rendering, PhotosPicker transfer integration and the complete CameraController still require iOS compilation. The Vision request remains confined to its serial worker, and results cross back through a main-actor Task.
- A temporary macOS executable compiled with Swift 5 complete concurrency and warnings as errors ran 19 adapted existing regression bodies using plain assertions instead of XCTest. It used the actual Core/Store/Combine/JSC/cache/DTO/sensor-transform code and bundled resources, a temporary LocationController stub, and unique temporary cache URLs. Checks passed for the four Store regressions, manual outbound/return progression, cache validation without overwrite, DTO round trips, replay, strict dates/Swiss DST service dates, sensor geometry/payload/freshness/epoch invalidation, and invalid image rejection. The UIKit raster test was excluded. Additional assertions passed for synchronous location delivery before request-context cleanup, restored manual demos refusing scripted steps, and explicit demo restart re-enabling them. These are **adapted macOS assertions, not 19 hosted XCTest results**.

Compiler-driven fixes: the location delegate conformance now declares its main-run-loop isolation contract with `@preconcurrency`; manager initialization remains main-actor isolated. The background observer uses an automatically cancelling Combine subscription, and deinit only cancels its Sendable timeout task, removing non-Sendable manager/observer accesses from nonisolated deinit. Explicit lifecycle `stop()` still cancels location requests. Store sinks use synchronous `MainActor.assumeIsolated` to preserve fix-before-completion ordering. The sensor crop test now spells `CGFloat.infinity` to avoid the actual compiler's ambiguous Double/CGFloat overload. The saved-demo test also asserts the manual/restart gate.

Temporary shims, adapted assertion helpers, executable and module cache live outside project source under `/tmp/rightside-review-checks`; none is shipped. The local final command sequence and output are `/tmp/rightside-review-checks/final-checks.sh` and `final-checks.log`. No npm, GitHub, signing credentials or global developer-directory change was used.

## Installed-Xcode follow-up (2026-11-21)

The synchronized source archive was verified as SHA-256 `f1039786019c330a5d8007cbf655e374e8dbf7f5f579742a7f7f6a03dcf579a7` (248,325 bytes). Its listed entries contained only relative regular files/directories; the previous `apps` and `scripts` trees were preserved before extraction at `/Users/samuelhitzinger/Projects/RightSide-backup-20261121-021930.tar.gz` (251,988 bytes, SHA-256 `2887f78cc480e7f937b53089718e409b59305e960a0ea655f286518a2d359ef3`). No source changes or compiler fixes were made in this follow-up.

Full Xcode is now installed at `/Applications/Xcode.app`; `DEVELOPER_DIR` was set locally to `/Applications/Xcode.app/Contents/Developer`. `xcodebuild -version` reports **Xcode 27.2, build 27B52**, on arm64 macOS 26.6.2 (25G83). The installed SDK directory and SDKSettings.json identify iOS 27.2. `xcodebuild -showsdks` is blocked by the unaccepted license, and `/Library/Developer/CoreSimulator` is absent. No available simulator runtime or physical-device readiness could be confirmed.

Actual commands and results:

- `sudo -n /usr/bin/xcodebuild -license accept`: exit 1, `sudo: a password is required`. A protected-file administrator password prompt was opened; no password was received during the follow-up.
- `xcodebuild -checkFirstLaunchStatus`: exit 69; `xcodebuild -runFirstLaunch`: exit 77. The first-launch run reports the unaccepted Xcode license; the status check produces no output.
- `bash scripts/build-ios.sh simulator`: exit 69 before compilation.
- `bash scripts/build-ios.sh device`: exit 69 before compilation.
- Both builds report: `You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.`
- `security find-identity -v -p codesigning`: `0 valid identities found`.

There is **no simulator app or unsigned IPA from this follow-up**; no hosted XCTest/UI tests ran (20 unit and two UI tests remain pending). The lack of a signing identity does not prevent the unsigned IPA build once Xcode setup is complete. After accepting the license and completing first launch, install an iOS simulator runtime as needed, rerun both build-script modes, then use `IOS_TEST_DESTINATION` with the script's `test` mode. No source defect has yet been established by the iOS compiler.

Device discovery returned exactly: `Agent device access is turned off for this environment. Ask the user to turn on the Device hub and Agent device access in Settings > Integrations > Devices; it applies when the agent session next starts, such as in a new thread.` This advice was relayed once; no device was opened or driven and no host/device IDs were returned. Automated Xcode tests can proceed after SDK/runtime setup without manual UI driving.

Local build evidence is retained under `/Users/samuelhitzinger/Projects/RightSide/dist/ios/logs/`. Exact log paths, byte sizes and SHA-256 checksums are in the local `/Users/samuelhitzinger/Projects/RightSide/dist/ios/build-report.txt`. Everything remained local; no GitHub operation or publication was performed.

## Fresh-session Xcode setup retry (2026-11-21)

A fresh secure administrator credential prompt completed. The credential was passed only through the protected file as standard input to `sudo -S -p '' /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -license accept`; sudo rejected authentication with one incorrect password attempt. No administrator operation completed, no previous chat was consulted, and no immediate repeat prompt was opened.

Xcode remains 27.2 (27B52). `xcodebuild -runFirstLaunch` exits 77, and both `bash scripts/build-ios.sh simulator` and `bash scripts/build-ios.sh device` exit 69 on the unaccepted license before compilation. No simulator app or unsigned IPA was produced; all 20 hosted unit tests and two UI tests remain unrun. There is no established iOS compiler defect to fix. Successful administrator authentication/license acceptance and first-launch setup remain prerequisites; a simulator runtime may still be needed afterwards. Device discovery remains disabled in this new session, returning no host/device IDs. No manual device driving was attempted.

Retry logs are under `dist/ios/logs/restart-20261121/`; exact paths, byte sizes and SHA-256 hashes are appended to `dist/ios/build-report.txt`. Source implementation is unchanged. The attempted progress message to the originating linked environment could not be delivered because this environment reports that the reverse link is unavailable.

## Successful setup and native builds (2026-11-21)

Fresh protected administrator authentication succeeded. Xcode licence acceptance, first-launch installation and the first-launch status check all returned exit 0. All commands selected `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; Xcode reports 27.2 (27B52) with iOS and iOS Simulator 27.2 SDKs.

Actual iOS compilation exposed three small source issues, now fixed: `CameraController.swift` imports SwiftUI so the PhotosUI SwiftUI overlay exposes `PhotosPickerItem`; `ContentView.swift` explicitly imports Combine for the timer publisher; the MapKit marker in `JourneyMapView.swift` uses `Color.rightSideTeal` to resolve its generic shape style.

- `bash scripts/build-ios.sh simulator`: exit 0, BUILD SUCCEEDED; simulator app at `dist/ios/DerivedData/Build/Products/Debug-iphonesimulator/RightSide.app`.
- `bash scripts/build-ios.sh device`: exit 0, BUILD SUCCEEDED; unsigned arm64 IPA at `dist/ios/RightSide-unsigned.ipa`, SHA-256 `327e6801527ff48b5a44e79bd19df883942de2307954d0e6d8a3b39720cb43e0`. ZIP integrity validation passed. It still requires signing before installation on an iPhone.
- `xcodebuild ... -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build-for-testing`: exit 0, TEST BUILD SUCCEEDED; both hosted XCTest and UI test targets compile.
- Test execution before runtime installation: exit 70, no matching simulator destination. This is **not a test pass**; all 20 unit and two UI tests remain unrun.

The required iOS 27.2 simulator runtime is an 8.32 GB download, started with `xcodebuild -downloadPlatform iOS`. Download/install progress is retained in `dist/ios/logs/validated-20261121/runtime-install.log`. No manual device UI driving was performed. Build diagnostics contain only the App Intents metadata-skipped warning for targets without an AppIntents dependency.

Logs are under `dist/ios/logs/validated-20261121/`. The integration patch is `dist/ios/native-compiler-fixes.patch`; it changes only the three Swift files above. The generated project, bundle resources and build script are unchanged.

A local continuation (`dist/ios/run-tests-after-runtime.py`) is waiting for the existing runtime installation to finish, then will run the full XCTest suite once on an available iPhone simulator. Its live state is `dist/ios/logs/validated-20261121/test-continuation-status.json`. A one-off follow-up in the same T3 thread is scheduled for 2026-11-21 at 05:40 Europe/Zurich (04:40 UTC) to inspect results and complete remaining fixes/validation. This queued work is not a test result.
