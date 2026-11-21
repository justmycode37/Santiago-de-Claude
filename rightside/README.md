# RightSide (native iOS) inside Santiago de Claude

RightSide is the native SwiftUI/ARKit companion to the Santiago de Claude web app: journey guidance on an
iPhone, with the camera used to find the right boarding point and to read the route number and destination on
an arriving bus or tram.

It was imported unchanged from the RightSide source snapshot of 21 November 2026
(`rightside-source-20261121.zip`, SHA-256 `f53023d668799f6e48f1b8783a1fa8cd7e33c5d2813a4cf5f9c3ce95756e6850`).
The directory layout of that snapshot is kept, so the scripts' relative paths still work:

| Path | What it is |
| --- | --- |
| `redesign/apps/ios/` | The active iOS app: Xcode project, sources, bundled models and data packs, XCTest targets. Its own README has the build history. |
| `redesign/scripts/` | Development and evaluation scripts from the RightSide project. Several refer to recordings that were not transferred. |
| `scripts/` | iPhone build/install helpers and the vehicle report test. |
| `SOURCE-NOTE.txt` | The note that came with the snapshot. |

The app is built on a Mac with Xcode (see `redesign/apps/ios/README.md`). It is not part of the static site:
`.vercelignore` excludes this folder. Text files here are kept with LF line endings (`.gitattributes`), because
the Xcode project and shell scripts are used on macOS.

Bundled third-party models and their licences are listed in
`redesign/apps/ios/RightSide/Resources/TransportPacks/model-manifest.json` (YOLOE, AGPL-3.0, needs a licensing
review before any proprietary release) and `redesign/apps/ios/RightSide/Resources/VehicleDisplayRecognition/v1/`
(PP-OCRv5 latin recogniser, Apache-2.0).
