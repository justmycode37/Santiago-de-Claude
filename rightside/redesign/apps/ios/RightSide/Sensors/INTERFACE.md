# Local vision additions (2026-11-21)

The current camera pipeline and evidence/pack contracts are documented in `docs/LOCAL-VISION.md` and `docs/SITE-PACKS.md`. `LiveCameraGuidanceView` accepts an optional `onObservation` callback for the existing domain vision contract; no authoritative service candidates are invented. Local surveyed poses pass the existing pose schema through `validateVisualPose`. Parent stop IDs cannot resolve a particular boarding area. The local camera is offline by default; Apple geographic AR is explicitly optional. The earlier sensor-reader notes below describe the baseline and are retained for the photo fallback.


## Historical baseline

# Native sensors and camera guidance (iOS 17+)

`LocationController` is main-actor isolated and owns one Core Location manager. `requestLocation()` obtains a planning fix; `startTracking()` starts foreground navigation updates; `stop()` cancels updates and heading. An active real journey starts tracking, backgrounding/arrival stops it. Permission denial and reduced accuracy remain explicit; `requestPreciseLocation()` uses the `JourneyNavigation` temporary-purpose string in Info.plist. Manager callbacks reject invalid, future, stale and out-of-order fixes. `isTracking` distinguishes ongoing updates from one-shot planning context.

Published values include authorization, accuracy authorization, status, isRequesting, isTracking, latestLocation, heading and the existing wire position JSON/Data. Core Location's raw coordinate, timestamp, accuracy and optional floor retain their provenance. `usableHeading(at:)` requires recent true heading with reported error at most 25 degrees. Coordinate uncertainty is not street-side/boarding evidence. No Always-location entitlement or background tracking is used.

`LiveCameraGuidanceView(context:location:visual:)` owns one `LiveCameraController` and ARSCNView. The context contains current journey/leg/phase identity, target texts and a geographic reference. ARKit checks hardware, camera permission, precise location and geographic coverage. Geographic anchors require localized/high status and normal camera tracking. Loss of tracking removes them; localization timeout leaves sign reading. Camera pose conversion uses ARSession.getGeoLocation, never OCR. Converted positions must be recent and consistent with the raw Core Location fix; they are stored in `VisualLocationStore` separately and expire after 10 seconds. Apple's qualitative high-accuracy state is not converted into an invented numeric uncertainty.

Vision reads camera frames on a serial queue. Only one OCR operation per session is in flight, throttled to 0.8-second intervals. Frame orientation is corrected; normalized OCR boxes are transformed through ARFrame.displayTransform into the actual viewport. Results require confidence >= 0.7, matching whole tokens, processing under 0.7 seconds and little camera movement. Highlights expire after 0.5 seconds. Epochs invalidate work after context/session changes, interruption, dismissal and backgrounding. Text matches never call the journey engine's `vision` event, confirm service identity, move position or advance progress.

`CameraGuidanceModels.swift` contains portable context matching, box transforms and visual-fix freshness models. `MapGeometry.lookAhead` chooses a mapped route reference only from a fresh fix with <=25 m reported error; off-route and competing return-path segments are rejected. Neither this point nor a transit centroid establishes a safe waiting area.

`CameraAssistanceView(line:destination:)` remains the still-photo/import fallback. The live AR session pauses before this view opens. Its existing image bounding, epoch invalidation, local OCR and system-picker lifecycle are preserved. Imported images have unverified capture time. Live and still controllers do not own simultaneous camera sessions.

There is no native bus segmentation model in this snapshot. Text rectangles are not segmentation masks. Do not replace this boundary with a generic foreground mask or fabricate a trained model. Physical-device alignment, lifecycle, permission, accuracy and thermal acceptance remain required; see the redesign's `docs/IMPLEMENTATION.md` and `docs/VALIDATION.md`.
