import Foundation
import CoreML
import CoreImage
import Vision
import ImageIO
import Accelerate

/// Fixed YOLOE 512 RGB model, FP16 weights, baked bus/tram/train prompts; no network calls.
/// Confined to the camera's serial worker, including model construction and all buffers.
final class TransportSegmenter {
    static let side = 512
    private let model: MLModel
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let input: CVPixelBuffer
    private let inputName: String
    init(url: URL? = Bundle.main.url(forResource: "TransportSegmenter", withExtension: "mlmodelc")) throws {
        guard let url else { throw VisionPipelineError.unavailable("Transport model is missing") }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        model = try MLModel(contentsOf: url, configuration: configuration)
        guard let name = model.modelDescription.inputDescriptionsByName.first(where: { $0.value.type == .image })?.key else {
            throw VisionPipelineError.unavailable("Transport model input is incompatible")
        }
        inputName = name
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(kCFAllocatorDefault, Self.side, Self.side, kCVPixelFormatType_32BGRA,
                                        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
        guard status == kCVReturnSuccess, let buffer else { throw VisionPipelineError.unavailable("Image allocation failed") }
        input = buffer
    }
    func detect(_ image: CIImage) throws -> [VehicleDetection] {
        let size = image.extent.size
        guard size.width > 0, size.height > 0 else { return [] }
        let scale = min(Double(Self.side) / size.width, Double(Self.side) / size.height)
        let dx = (Double(Self.side) - size.width * scale) / 2
        let dy = (Double(Self.side) - size.height * scale) / 2
        let background = CIImage(color: CIColor(red: 114 / 255.0, green: 114 / 255.0, blue: 114 / 255.0))
            .cropped(to: CGRect(x: 0, y: 0, width: Self.side, height: Self.side))
        let prepared = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: dx, y: dy)).composited(over: background)
        context.render(prepared, to: input, bounds: background.extent, colorSpace: CGColorSpaceCreateDeviceRGB())
        let output = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: input)]))
        let arrays = output.featureNames.compactMap { output.featureValue(for: $0)?.multiArrayValue }
        guard let boxes = arrays.first(where: { $0.shape.count == 3 && $0.shape[1].intValue == 39 }),
              let proto = arrays.first(where: { $0.shape.count == 4 && $0.shape[1].intValue == 32 }) else {
            throw VisionPipelineError.unavailable("Transport model output is incompatible")
        }
        return Self.decode(boxes: boxes, prototypes: proto, imageSize: size, scale: scale, padding: CGPoint(x: dx, y: dy))
    }
    /// Export contract: [1, 4 + 3 + 32, N] xywh, class scores, mask coefficients; [1,32,H,W].
    static func decode(boxes: MLMultiArray, prototypes: MLMultiArray, imageSize: CGSize,
                       scale: Double, padding: CGPoint) -> [VehicleDetection] {
        guard boxes.shape.count == 3, boxes.shape[0].intValue == 1, boxes.shape[1].intValue == 39,
              prototypes.shape.count == 4, prototypes.shape[0].intValue == 1, prototypes.shape[1].intValue == 32,
              let boxData = contiguousFloats(boxes), let planes = contiguousFloats(prototypes) else { return [] }
        let count = boxes.shape[2].intValue
        func value(_ row: Int, _ column: Int) -> Float { boxData[row * count + column] }
        var candidates: [(index: Int, kind: TransportClass, score: Float, box: CGRect, margin: Float, runnerUp: TransportClass?)] = []
        for i in 0..<count {
            let scores = (0..<3).map { value(4 + $0, i) }
            guard let best = scores.indices.max(by: { scores[$0] < scores[$1] }), scores[best].isFinite, scores[best] >= 0.35 else { continue }
            // An unsure class (zero-shot tram/train) no longer drops the vehicle: the class is only its caption and is
            // never resolved from the expected journey mode. Which service it is comes from its display alone.
            let second = scores.indices.filter { $0 != best }.max(by: { scores[$0] < scores[$1] })
            let margin = second.map { scores[best] - scores[$0] } ?? 1
            let x = Double(value(0, i)), y = Double(value(1, i)), w = Double(value(2, i)), h = Double(value(3, i))
            guard [x,y,w,h].allSatisfy(\.isFinite), w > 0, h > 0 else { continue }
            let rect = CGRect(x: (x - w / 2 - padding.x) / scale / imageSize.width,
                              y: (y - h / 2 - padding.y) / scale / imageSize.height,
                              width: w / scale / imageSize.width, height: h / scale / imageSize.height)
                .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
            if !rect.isNull, rect.width > 0.03, rect.height > 0.03 {
                candidates.append((i, TransportClass.allCases[best], scores[best], rect, margin.isFinite ? margin : 0,
                                   second.map { TransportClass.allCases[$0] }))
            }
        }
        // Class-agnostic suppression prevents duplicate bus/tram hypotheses on the same physical object.
        var retained: [(index: Int, kind: TransportClass, score: Float, box: CGRect, margin: Float, runnerUp: TransportClass?)] = []
        for candidate in candidates.sorted(by: { $0.score > $1.score }).prefix(200) {
            if retained.allSatisfy({ VehicleTracker.iou($0.box, candidate.box) < 0.45 }) { retained.append(candidate) }
            if retained.count == VehicleTracker.maximumTracks { break }
        }
        let ph = prototypes.shape[2].intValue, pw = prototypes.shape[3].intValue
        let mw = 128, mh = 128
        return retained.compactMap { candidate in
            var coefficients = (0..<32).map { value(7 + $0, candidate.index) }
            guard coefficients.allSatisfy(\.isFinite) else { return nil }
            var logits = [Float](repeating: 0, count: ph * pw)
            vDSP_mmul(&coefficients, 1, planes, 1, &logits, 1, 1, vDSP_Length(ph * pw), 32)
            var mask = [UInt8](repeating: 0, count: mw * mh)
            for y in 0..<mh { for x in 0..<mw {
                let point = CGPoint(x: (Double(x) + 0.5) / Double(mw), y: (Double(y) + 0.5) / Double(mh))
                guard candidate.box.contains(point) else { continue }
                let px = min(pw - 1, max(0, Int((point.x * imageSize.width * scale + padding.x) / Double(Self.side) * Double(pw))))
                let py = min(ph - 1, max(0, Int((point.y * imageSize.height * scale + padding.y) / Double(Self.side) * Double(ph))))
                mask[y * mw + x] = logits[py * pw + px] > 0 ? 1 : 0
            } }
            guard mask.contains(1) else { return nil }
            return VehicleDetection(kind: candidate.kind, box: candidate.box, score: candidate.score,
                                    mask: VehicleMask(width: mw, height: mh, pixels: mask),
                                    classMargin: candidate.margin, runnerUp: candidate.runnerUp)
        }
    }
    private static func contiguousFloats(_ array: MLMultiArray) -> [Float]? {
        var stride = 1
        for i in array.shape.indices.reversed() {
            guard array.strides[i].intValue == stride else { return nil }
            stride *= array.shape[i].intValue
        }
        guard stride <= 1_000_000 else { return nil }
        // Read native buffers once. NSNumber subscripting here adds hundreds of thousands of allocations/frame.
        switch array.dataType {
        case .float32: return Array(UnsafeBufferPointer(start: array.dataPointer.assumingMemoryBound(to: Float.self), count: stride))
        case .float16: return UnsafeBufferPointer(start: array.dataPointer.assumingMemoryBound(to: Float16.self), count: stride).map(Float.init)
        case .double: return UnsafeBufferPointer(start: array.dataPointer.assumingMemoryBound(to: Double.self), count: stride).map(Float.init)
        default: return nil
        }
    }
}

enum VisionPipelineError: LocalizedError {
    case unavailable(String)
    var errorDescription: String? { if case let .unavailable(message) = self { return message }; return nil }
}

/// Bounded diagnostics for replay; never used as authoritative context or primary-card copy.
struct VehicleRecognitionDiagnostic {
    let trackID: UUID
    let visionTexts: [VehicleText]
    let proposal: VehicleDisplayRecognitionPolicy.Proposal?
    let alternative: AlternativeDisplayObservation?
    let additionalAlternatives: [AlternativeDisplayObservation]
    let fallbackFailure: String?
    let proposalRejectionReason: String?
    var displayIssue: DisplayRecognitionIssue? = nil
}

struct VehicleFrameResult {
    let tracks: [VehicleTrack]
    let lost: [UUID]
    let latencyMS: Double
    let imageSize: CGSize
    let signTexts: [VehicleText]
    var recognitionDiagnostics: [VehicleRecognitionDiagnostic] = []
    var displayIssues: [UUID: DisplayRecognitionIssue] {
        Dictionary(uniqueKeysWithValues: recognitionDiagnostics.compactMap { item in
            item.displayIssue.map { (item.trackID, $0) }
        })
    }
}

/// At most three instances receive body + display OCR in each frame. Rotate this bounded
/// budget so a lower-scoring visible vehicle is not permanently excluded from sign reading.
struct VehicleOCRSchedule {
    private var cursor = 0
    mutating func reset() { cursor = 0 }
    mutating func indices(trackCount: Int) -> [Int] {
        guard trackCount > 0 else { reset(); return [] }
        let count = min(trackCount, VehicleTracker.maximumTracks)
        let chosen = (0..<min(3, count)).map { (cursor + $0) % count }
        cursor = (cursor + chosen.count) % count
        return chosen
    }
}

/// Explicit replay experiment; normal camera callers keep the established sampling.
enum VehicleOCRSceneDetail { case standard, high, adaptive
    var maximumDimension: CGFloat { self == .standard ? 1280 : 1920 }
    func maximumDimension(for source: CGSize) -> CGFloat {
        // Keep the established sampling for1080p camera frames. The detailed pass is
        // reserved for sources where1280px would discard more than half the linear detail.
        self == .adaptive && max(source.width, source.height) <= 2560 ? 1280 : maximumDimension
    }
}

// Only the serial worker owns mutable state; VisionWorkGate prevents overlapping jobs across restarts.
final class LocalVehiclePipeline: @unchecked Sendable {
    private var detector: TransportSegmenter?
    private let modelURL: URL?
    private let sceneDetail: VehicleOCRSceneDetail
    private let displayLayout: VehicleDisplayLayout
    private let routeReread: Bool
    private let displayModelURL: URL?
    private let displayCharactersURL: URL?
    private var displayRecognizer: VehicleDisplayRecognizer?
    private var displayLoadState = DisplayRecognitionLoadState()
    private var tracker = VehicleTracker()
    private var ocrSchedule = VehicleOCRSchedule()
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private var epoch: UUID?
    var trace: ((String) -> Void)?
    var displayRecognitionLevel: VNRequestTextRecognitionLevel = .accurate
    init(modelURL: URL? = Bundle.main.url(forResource: "TransportSegmenter", withExtension: "mlmodelc"),
         displayModelURL: URL? = Bundle.main.url(forResource: "VehicleDisplayRecognizer", withExtension: "mlmodelc"),
         displayCharactersURL: URL? = Bundle.main.url(forResource: "display-characters", withExtension: "json"),
         sceneDetail: VehicleOCRSceneDetail = .standard, displayLayout: VehicleDisplayLayout = .routeFirst, routeReread: Bool = false) {
        self.modelURL = modelURL
        self.sceneDetail = sceneDetail
        self.displayLayout = displayLayout
        self.routeReread = routeReread
        self.displayModelURL = displayModelURL
        self.displayCharactersURL = displayCharactersURL
    }
    /// `shift`: how far the phone's turn moved the picture since the last processed frame; `trackGap`: how long a
    /// track outlives not being seen (both from LiveCameraGuidance, see VehicleTracker).
    func process(buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, at: Date, epoch: UUID,
                 shift: CGPoint = .zero, trackGap: TimeInterval = 0.9) throws -> VehicleFrameResult {
        try process(upright: CIImage(cvPixelBuffer: buffer).oriented(orientation), at: at, epoch: epoch, shift: shift, trackGap: trackGap)
    }
    /// The same inference path accepts bounded recorded inputs for reproducible native evaluation.
    /// Callers label replay and supply its clock; it does not write a live camera observation.
    func process(upright image: CIImage, at: Date, epoch: UUID, shift: CGPoint = .zero, trackGap: TimeInterval = 0.9) throws -> VehicleFrameResult {
        let started = ProcessInfo.processInfo.systemUptime
        if self.epoch != epoch { tracker.reset(); ocrSchedule.reset(); self.epoch = epoch }
        if detector == nil { detector = try TransportSegmenter(url: modelURL) }
        let detections = try detector!.detect(image)
        tracker.maximumGap = trackGap
        tracker.update(detections, at: at, shift: shift)
        let frameID = UUID()
        var signTexts: [VehicleText] = []
        var diagnostics: [VehicleRecognitionDiagnostic] = []
        if detections.isEmpty {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .fast; request.usesLanguageCorrection = false
            try VNImageRequestHandler(ciImage: image).perform([request])
            signTexts = Array((request.results ?? []).prefix(30)).compactMap { item in
                guard let candidate = item.topCandidates(1).first, candidate.confidence >= 0.7 else { return nil }
                let r = item.boundingBox
                return VehicleText(text: candidate.string, box: CGRect(x: r.minX, y: 1-r.maxY, width: r.width, height: r.height), score: candidate.confidence)
            }
        }
        // At most twelve OCR requests/frame: body + display + two small glyph scales for three tracks.
        // Refinement requires an observed same-instance display row; no queued camera frames.
        for index in ocrSchedule.indices(trackCount: tracker.tracks.count) {
            let track = tracker.tracks[index]
            let b = track.detection.box
            let crop = CGRect(x: b.minX * image.extent.width, y: (1 - b.maxY) * image.extent.height,
                              width: b.width * image.extent.width, height: b.height * image.extent.height).integral.intersection(image.extent)
            guard crop.width >= 48, crop.height >= 32 else { continue }
            // A bounded scene-scale pass separates display fragments consistently; later display
            // and glyph crops still use original sensor pixels rather than this reduced image.
            let bodyScale = min(1, sceneDetail.maximumDimension(for: image.extent.size) / max(image.extent.width, image.extent.height))
            let bodyImage = image.transformed(by: CGAffineTransform(scaleX: bodyScale, y: bodyScale))
            // Round after resizing. Rounding before resizing shifts LED strokes by half a pixel
            // at some sensor resolutions and can change a readable glyph into low-confidence OCR.
            let bodyCrop = CGRect(x: b.minX * bodyImage.extent.width, y: (1-b.maxY) * bodyImage.extent.height,
                                  width: b.width * bodyImage.extent.width, height: b.height * bodyImage.extent.height)
                .integral.intersection(bodyImage.extent)
            guard let cgImage = imageContext.createCGImage(bodyImage, from: bodyCrop) else { continue }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
            request.recognitionLanguages = ["de-DE", "fr-FR", "en-US"]
            request.minimumTextHeight = 0.025
            try VNImageRequestHandler(cgImage: cgImage).perform([request])
            // Use the actual integral crop for inverse mapping, not the pre-rounded detection box.
            let actual = CGRect(x: bodyCrop.minX / bodyImage.extent.width, y: 1 - bodyCrop.maxY / bodyImage.extent.height,
                                width: bodyCrop.width / bodyImage.extent.width, height: bodyCrop.height / bodyImage.extent.height)
            var texts = (request.results ?? []).compactMap { item -> VehicleText? in
                guard let candidate = item.topCandidates(1).first else { return nil }
                let r = item.boundingBox
                return VehicleText(text: candidate.string,
                    box: CGRect(x: actual.minX + r.minX * actual.width, y: actual.minY + (1 - r.maxY) * actual.height,
                                width: r.width * actual.width, height: r.height * actual.height), score: candidate.confidence)
            }
            let otherBoxes = tracker.tracks.filter { $0.id != track.id }.map { $0.detection.box }
            texts.append(contentsOf: displayFragments(request.results ?? [],roi:actual,detection:track.detection,otherBoxes:otherBoxes))
            var refinementAttempted = false
            if let refined = try refineGlyph(texts, detection: track.detection, otherBoxes: otherBoxes, image: image) {
                texts.append(contentsOf: refined); refinementAttempted = true
            }
            let preliminary = VehicleTextRules.read(texts, detection: track.detection, otherBoxes: otherBoxes, at: at, frameID: frameID, layout: displayLayout)
            // Avoid an expensive redundant wide OCR pass after a complete same-instance reading.
            // No expected route text enters this scheduling decision.
            if preliminary.line == nil || preliminary.destination == nil || preliminary.ambiguous {
                // Dedicated display ROI: preserve the original sensor detail, enlarge only up to 1600px.
                // No language correction or journey-conditioned words; a second pass can remain unreadable.
                let displayCrop = CGRect(x: crop.minX, y: crop.minY + crop.height * 0.45,
                                         width: crop.width, height: crop.height * 0.55).integral.intersection(image.extent)
                let displayScale = min(2, 1600 / displayCrop.width)
                let displayImage = image.cropped(to: displayCrop).transformed(by: CGAffineTransform(scaleX: displayScale, y: displayScale))
                if let displayCG = imageContext.createCGImage(displayImage, from: displayImage.extent) {
                    let displayRequest = VNRecognizeTextRequest()
                    displayRequest.recognitionLevel = displayRecognitionLevel; displayRequest.usesLanguageCorrection = false
                    displayRequest.recognitionLanguages = ["de-DE", "fr-FR", "en-US"]
                    // Half the body pass's floor: a far display's lines are small even in its own band, and a weak
                    // line Vision boxes here can still be re-read by the second recognizer (unanchoredRegions).
                    displayRequest.minimumTextHeight = 0.0125
                    try VNImageRequestHandler(cgImage: displayCG).perform([displayRequest])
                    let roi = CGRect(x: displayCrop.minX / image.extent.width, y: 1-displayCrop.maxY/image.extent.height,
                                     width: displayCrop.width/image.extent.width, height: displayCrop.height/image.extent.height)
                    let fragments = displayFragments(displayRequest.results ?? [],roi:roi,detection:track.detection,otherBoxes:otherBoxes)
                    for item in displayRequest.results ?? [] {
                        guard let candidate = item.topCandidates(1).first else { continue }
                        let r = item.boundingBox
                        let text = VehicleText(text: candidate.string, box: CGRect(x: roi.minX+r.minX*roi.width, y: roi.minY+(1-r.maxY)*roi.height,
                                                                                 width: r.width*roi.width,height: r.height*roi.height), score: candidate.confidence)
                        // Keep conflicts between passes. Only identical readings are deduplicated.
                        if let index = texts.firstIndex(where: { $0.text == text.text && VehicleTracker.iou($0.box,text.box) > 0.5 }) {
                            if text.score > texts[index].score { texts[index] = text }
                        } else { texts.append(text) }
                    }
                    texts.append(contentsOf:fragments)
                }
            }
            if !refinementAttempted, let refined = try refineGlyph(texts, detection: track.detection, otherBoxes: otherBoxes, image: image) {
                texts.append(contentsOf: refined)
            }
            trace?("OCR candidates \(track.detection.kind): \(texts.map { "\($0.text) [\($0.score)] \($0.box)" })")
            var reading = VehicleTextRules.read(texts, detection: track.detection, otherBoxes: otherBoxes, at: at, frameID: frameID, layout: displayLayout)
            var proposal: VehicleDisplayRecognitionPolicy.Proposal?
            var alternative: AlternativeDisplayObservation?
            var additionalAlternatives: [AlternativeDisplayObservation] = []
            var fallbackFailure: String?
            var displayIssue: DisplayRecognitionIssue? = reading.line == nil || reading.destination == nil ? displayLoadState.issue : nil
            // Preserve a complete or conflicting Vision result. Only incomplete actual display
            // evidence requests this bounded second engine; no journey words enter either model.
            if !reading.ambiguous, !reading.outOfService, reading.line == nil || reading.destination == nil,
               let region = VehicleDisplayRecognitionPolicy.proposal(texts,detection:track.detection,otherBoxes:otherBoxes,layout:displayLayout) {
                proposal = region
                if displayLoadState.begin(modelPresent: displayModelURL != nil, dictionaryPresent: displayCharactersURL != nil),
                   let displayModelURL, let displayCharactersURL {
                    do { displayRecognizer = try VehicleDisplayRecognizer(modelURL: displayModelURL, charactersURL: displayCharactersURL) }
                    catch { displayLoadState.rejectInitialization() }
                }
                if let displayRecognizer {
                    var observations: [AlternativeDisplayObservation] = []
                    let inputs: [(String, CIImage)] = bodyScale < 1 ? [("native",image),("scene-\(Int(sceneDetail.maximumDimension(for: image.extent.size)))",bodyImage)] : [("native",image)]
                    // Correlated crops remain one actual observation; preserve all existing gates.
                    for (sampling,input) in inputs {
                        do {
                            if let observation = try displayRecognizer.recognize(image: input, proposal: region, trackID: track.id,
                                frameID: frameID, capturedAt: at, samplingID: sampling) { observations.append(observation) }
                        } catch { fallbackFailure = "display_crop_unsupported_or_failed" }
                    }
                    alternative = observations.first
                    additionalAlternatives = Array(observations.dropFirst())
                    if let result = VehicleDisplayRecognitionPolicy.reading(observations, proposal: region,
                        visionTexts: texts, detection: track.detection, otherBoxes: otherBoxes, trackID: track.id, frameID: frameID, at: at, layout: displayLayout) {
                        reading = result
                    } else if observations.isEmpty {
                        displayIssue = .samplingFailed
                        fallbackFailure = "display_crop_unsupported_or_failed"
                    }
                } else {
                    displayIssue = displayLoadState.issue
                    fallbackFailure = displayIssue == .initializationFailed ? "display_recognition_failed" : "display_model_unavailable"
                }
            }
            // No accepted route numeral, so no proposal: the second recognizer still re-reads Vision's weak lines in
            // the display band. What it reads confidently joins the frame's text; the matcher decides as always.
            if proposal == nil, !reading.ambiguous, !reading.outOfService, reading.line == nil || reading.destination == nil {
                let regions = VehicleDisplayRecognitionPolicy.unanchoredRegions(texts, detection: track.detection, otherBoxes: otherBoxes)
                if !regions.isEmpty, displayLoadState.begin(modelPresent: displayModelURL != nil, dictionaryPresent: displayCharactersURL != nil),
                   let displayModelURL, let displayCharactersURL {
                    do { displayRecognizer = try VehicleDisplayRecognizer(modelURL: displayModelURL, charactersURL: displayCharactersURL) }
                    catch { displayLoadState.rejectInitialization() }
                }
                if !regions.isEmpty, let displayRecognizer {
                    var reread: [VehicleText] = []
                    for region in regions {
                        do {
                            if let observation = try displayRecognizer.recognize(image: image, region: region, trackID: track.id,
                                frameID: frameID, capturedAt: at, samplingID: "unanchored-native") {
                                additionalAlternatives.append(observation)
                                if let text = VehicleDisplayRecognitionPolicy.unanchoredText(observation, trackID: track.id, frameID: frameID, at: at) {
                                    reread.append(text)
                                }
                            }
                        } catch { fallbackFailure = "display_crop_unsupported_or_failed" }
                    }
                    if !reread.isEmpty {
                        texts.append(contentsOf: reread)
                        reading = VehicleTextRules.read(texts, detection: track.detection, otherBoxes: otherBoxes, at: at, frameID: frameID, layout: displayLayout)
                    }
                }
            }
            if routeReread, !reading.ambiguous, !reading.outOfService, reading.line == nil,
               let route = VehicleRouteRecognitionPolicy.proposal(texts, detection: track.detection, otherBoxes: otherBoxes) {
                if displayLoadState.begin(modelPresent: displayModelURL != nil, dictionaryPresent: displayCharactersURL != nil),
                   let displayModelURL, let displayCharactersURL {
                    do { displayRecognizer = try VehicleDisplayRecognizer(modelURL: displayModelURL, charactersURL: displayCharactersURL) }
                    catch { displayLoadState.rejectInitialization() }
                }
                if let displayRecognizer {
                    var routeObservations: [AlternativeDisplayObservation] = []
                    // Two bounded crop samplings, same frame/provenance; no queued work or journey input.
                    let inputs: [(String, CIImage)] = bodyScale < 1 ? [("route-native", image), ("route-scene", bodyImage)] : [("route-native", image)]
                    for (sampling, input) in inputs {
                        do {
                            if let observation = try displayRecognizer.recognize(image: input, region: route.route.box,
                                trackID: track.id, frameID: frameID, capturedAt: at, samplingID: sampling) { routeObservations.append(observation) }
                        } catch { fallbackFailure = "route_crop_unsupported_or_failed" }
                    }
                    additionalAlternatives.append(contentsOf: routeObservations)
                    if let result = VehicleRouteRecognitionPolicy.reading(routeObservations, proposal: route, texts: texts,
                        detection: track.detection, otherBoxes: otherBoxes, trackID: track.id, frameID: frameID, at: at) { reading = result }
                } else { displayIssue = displayLoadState.issue }
            }
            diagnostics.append(.init(trackID:track.id,visionTexts:texts,proposal:proposal,alternative:alternative,additionalAlternatives:additionalAlternatives,fallbackFailure:fallbackFailure,
                proposalRejectionReason:proposal == nil ? VehicleDisplayRecognitionPolicy.proposalRejectionReason(texts,detection:track.detection,otherBoxes:otherBoxes):nil, displayIssue:displayIssue))
            tracker.record(reading, trackID: track.id)
        }
        return VehicleFrameResult(tracks: tracker.tracks, lost: tracker.lost,
                                  latencyMS: (ProcessInfo.processInfo.systemUptime - started) * 1000, imageSize: image.extent.size, signTexts: signTexts, recognitionDiagnostics:diagnostics)
    }
    /// Vision's observed substring boxes can separate a whole display row more precisely
    /// than independently detected overlapping word rectangles. Confidence stays unchanged.
    /// The entire source row must first belong to this mask and no other vehicle.
    private func displayFragments(_ observations:[VNRecognizedTextObservation],roi:CGRect,
                                  detection:VehicleDetection,otherBoxes:[CGRect]) -> [VehicleText] {
        let regex = try? NSRegularExpression(pattern:#"^\s*([A-Za-z]{0,2}\s?\d{1,3})\s+(.+?)\s*$"#)
        func mapped(_ r:CGRect) -> CGRect { CGRect(x:roi.minX+r.minX*roi.width,y:roi.minY+(1-r.maxY)*roi.height,
            width:r.width*roi.width,height:r.height*roi.height) }
        var fragments:[VehicleText] = []
        for observation in observations.prefix(30) {
            guard let text = observation.topCandidates(1).first, text.confidence>=0.3,text.confidence<0.7,
                  VehicleDisplayRecognitionPolicy.associated(mapped(observation.boundingBox),detection:detection,otherBoxes:otherBoxes),
                  let match = regex?.firstMatch(in:text.string,range:NSRange(text.string.startIndex...,in:text.string)),
                  let route = Range(match.range(at:1),in:text.string),let destination = Range(match.range(at:2),in:text.string),
                  String(text.string[destination]).rangeOfCharacter(from:.letters) != nil else { continue }
            for range in [route,destination] {
                guard let bounds = try? text.boundingBox(for:range) else { continue }
                fragments.append(VehicleText(text:String(text.string[range]),box:mapped(bounds.boundingBox),score:text.confidence))
            }
        }
        return fragments
    }

    /// Nil means no eligible geometry; an empty result means the bounded attempt was unreadable.
    private func refineGlyph(_ texts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect], image: CIImage) throws -> [VehicleText]? {
        guard let region = VehicleTextRules.refinementRegion(texts, detection: detection, otherBoxes: otherBoxes, layout: displayLayout)
            ?? VehicleDisplayRecognitionPolicy.glyphRefinementRegion(texts,detection:detection,otherBoxes:otherBoxes) else { return nil }
        var refinedTexts: [VehicleText] = []
        let sceneScale = min(1, 1280 / max(image.extent.width, image.extent.height))
        let inputs = sceneScale < 1
            ? [image, image.transformed(by: CGAffineTransform(scaleX: sceneScale, y: sceneScale))] : [image]
        // Native and scene-scale crops can resolve different LED sampling patterns. Keep both
        // observations so contradictory confident glyphs abstain rather than choosing a scale
        // based on the selected journey. Each crop is bounded independently to384px.
        for input in inputs {
            let pixels = CGRect(x: region.minX * input.extent.width, y: (1-region.maxY) * input.extent.height,
                                width: region.width * input.extent.width, height: region.height * input.extent.height)
                .integral.intersection(input.extent)
            // Preserve sensor detail; bound the extra crop to 384px. Contrast/grayscale help
            // dotted displays without adding text or consulting the selected journey.
            let scale = min(2, 384 / max(pixels.width, pixels.height))
            let refined = input.cropped(to: pixels).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0, kCIInputContrastKey: 1.4])
            if let cg = imageContext.createCGImage(refined, from: refined.extent) {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
                request.recognitionLanguages = ["de-DE", "fr-FR", "en-US"]; request.minimumTextHeight = 0.05
                try VNImageRequestHandler(cgImage: cg).perform([request])
                for item in request.results ?? [] {
                    guard let candidate = item.topCandidates(1).first else { continue }
                    let r = item.boundingBox
                    refinedTexts.append(VehicleText(text: candidate.string,
                        box: CGRect(x: (pixels.minX+r.minX*pixels.width)/input.extent.width,
                                    y: 1-(pixels.minY+r.maxY*pixels.height)/input.extent.height,
                                    width: r.width*pixels.width/input.extent.width,
                                    height: r.height*pixels.height/input.extent.height), score: candidate.confidence))
                }
            }
        }
        return refinedTexts
    }

}
