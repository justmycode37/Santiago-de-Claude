# AR camera on a journey step

The **AR** button sits next to **3D view** on a walk or change step that has a ride to board next
(`src/app/65-ar.ts`). It opens Scan's live camera (`src/stopvision.ts`) in an AR mode. There is no shutter: it
runs by itself until it is closed. `?ar=0` in the address hides the button (remembered; `?ar=1` shows it again).

| Part | How | Status |
| --- | --- | --- |
| Stop and boarding edge | Scan's sign OCR + GPS + compass. It outlines the sign and says where the next ride leaves from ([scan.md](scan.md)). | Live |
| Vehicle outline | COCO-SSD (TensorFlow.js `lite_mobilenet_v2`, from jsDelivr) finds buses, trams and trains about 3× a second. | Live; recall and speed on phones not measured |
| Which vehicle | The words Scan reads on the biggest vehicle (`scan:words`) go to `ARCORE.read` → `ARCORE.decide` (`src/arcore.ts`, RightSide's display matcher). They are compared with the ride and the Kante `/api/due` services: "Your bus 10 → …" or "Not yours: 9 → …". Until a display is read, the label only says what is due now. | Live; whether Tesseract reads LED displays is not measured |
| The way | A direction arrow toward the boarding edge plus the distance. Drawn only with a fresh compass heading and GPS accuracy of 30 m or better. | Live; a direction only, not anchored to the floor |

## The decision logic

`src/arcore.ts` is DOM-free and shared with Node (`tools/test_arcore.mts`, part of `npm test`). It reproduces the
Swift display bench (`rightside/tools/display-bench`) exactly. Dev set: 76/111 right vehicles accepted. Held-out
set: 27/35. No wrong vehicle accepted in either. Those numbers come from PP-OCR text on recorded video, not from the
web's Tesseract on a phone.

## Not done yet

- Floor-anchored arrows. iOS Safari has no WebXR, so they belong to the native app (ARKit, `rightside/`), which can
  reuse this logic.
- Fusing what the camera sees into the position (sign as a position anchor, compass bias). The planning reviews found
  that a close sign cannot correct the compass, and that a vehicle read says little about where you are.
- `/api/identify` as a consistency check. Its `bearing` is the vehicle's travel direction, not the camera heading.
- **Only a real phone at a real stop can tell:** detector speed and recall, LED display OCR, compass bias near trams,
  the iOS permission flow, battery and heat.
