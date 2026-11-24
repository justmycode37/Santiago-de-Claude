import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A capability failure is separate from unreadable pixels and from service evidence.
enum DisplayRecognitionIssue: String, Equatable {
    case missingModel, missingDictionary, initializationFailed, samplingFailed
    var instruction: String {
        switch self {
        case .missingModel, .missingDictionary, .initializationFailed:
            return "Extended display recognition is unavailable. Read the line and destination on the vehicle, use the departure list, or ask staff."
        case .samplingFailed:
            return "This display could not be processed. Reframe its line and destination, or check the departure list."
        }
    }
}

/// One initialization attempt per pipeline, including a stable reason after failure.
/// Restarting tracking does not retry an incompatible or missing bundled model every frame.
struct DisplayRecognitionLoadState {
    private(set) var attempted = false
    private(set) var issue: DisplayRecognitionIssue?
    mutating func begin(modelPresent: Bool, dictionaryPresent: Bool) -> Bool {
        guard !attempted else { return false }
        attempted = true
        if !modelPresent { issue = .missingModel; return false }
        if !dictionaryPresent { issue = .missingDictionary; return false }
        return true
    }
    mutating func rejectInitialization() { issue = .initializationFailed }
}

/// Diagnostic provenance stays distinct from Vision's raw confidence. Neither is calibrated
/// service probability. These observations cannot bind a trip or locate a passenger.
struct AlternativeDisplayObservation {
    let engineID: String
    let modelID: String
    let configID: String
    let frameID: UUID
    let capturedAt: Date
    let trackID: UUID
    let text: String
    let characterScores: [Float]
    let region: CGRect
    let samplingID: String
}

enum VehicleDisplayRecognitionPolicy {
    static let engineID = "paddle-latin-v5-coreml"
    static let modelID = "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498"
    static let configID = "bgr-linear-48-ctc-unpadded-v1"

    struct Proposal {
        let route: VehicleText
        let headsign: VehicleText
        var region: CGRect { headsign.box }
    }

    /// A second recognizer only sees a single observed headsign beside an accepted Vision
    /// route numeral, in this actual vehicle's mask. No journey word is an input.
    static func proposal(_ texts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect], layout: VehicleDisplayLayout = .routeFirst) -> Proposal? {
        let eligible = texts.filter { associated($0.box, detection: detection, otherBoxes: otherBoxes)
            && $0.box.midY < detection.box.minY + detection.box.height * 0.65 }
        let routes = eligible.filter { $0.score >= 0.7 && $0.score.isFinite
            && $0.text.range(of: #"^[A-Za-z]{0,2}\s?\d{1,3}$"#, options: .regularExpression) != nil }
        var proposals: [Proposal] = []
        for route in routes {
            let headsigns = eligible.filter { text in
                text.score.isFinite && text.score >= 0.3 && text.score < 0.7
                    && text.text.rangeOfCharacter(from: .letters) != nil
                    && VehicleTextRules.adjacentDestination(text, to: route, layout: layout)
            }
            for headsign in headsigns {
                let p = Proposal(route:route,headsign:headsign)
                if !proposals.contains(where: { VehicleTextRules.normalize($0.route.text) == VehicleTextRules.normalize(route.text)
                    && VehicleTracker.iou($0.region,headsign.box)>0.8 }) { proposals.append(p) }
            }
        }
        return proposals.count == 1 ? proposals[0] : nil
    }

    /// Replay diagnostics only: explain refusal without promoting uncertain OCR.
    static func proposalRejectionReason(_ texts:[VehicleText],detection:VehicleDetection,otherBoxes:[CGRect]) -> String? {
        if proposal(texts,detection:detection,otherBoxes:otherBoxes) != nil { return nil }
        if texts.isEmpty { return "no_observed_text" }
        let associatedTexts = texts.filter { associated($0.box,detection:detection,otherBoxes:otherBoxes) }
        if associatedTexts.isEmpty { return "text_not_exclusively_inside_mask" }
        let upper = associatedTexts.filter { $0.box.midY<detection.box.minY+detection.box.height*0.65 }
        if upper.isEmpty { return "no_upper_display_text" }
        let routes = upper.filter { $0.score.isFinite && $0.score>=0.7 && $0.text.range(of:#"^[A-Za-z]{0,2}\s?\d{1,3}$"#,options:.regularExpression) != nil }
        if routes.isEmpty { return "no_route_meeting_vision_threshold" }
        let headsigns = upper.filter { $0.score.isFinite && $0.score>=0.3 && $0.score<0.7 && $0.text.rangeOfCharacter(from:.letters) != nil }
        if headsigns.isEmpty { return "no_headsign_refinement_proposal" }
        if routes.contains(where: { r in headsigns.contains { h in
            h.box.midX>r.box.midX && h.box.minX<r.box.maxX && abs(h.box.midY-r.box.midY)<=max(h.box.height,r.box.height)*0.3
        } }) { return "observed_fragment_boxes_overlap" }
        return "no_unique_adjacent_masked_display_pair"
    }

    /// Weak OCR proposes only a bounded re-read of an observed route glyph. It cannot
    /// supply a reading: the re-read must still meet Vision0.7 and the headsign must
    /// independently meet the pinned alternative engine policy. No expected text enters.
    static func glyphRefinementRegion(_ texts:[VehicleText],detection:VehicleDetection,otherBoxes:[CGRect]) -> CGRect? {
        let eligible = texts.filter { $0.score.isFinite && $0.score>=0.3
            && associated($0.box,detection:detection,otherBoxes:otherBoxes)
            && $0.box.midY<detection.box.minY+detection.box.height*0.65 }
        var routes:[VehicleText] = []
        for route in eligible where route.score<0.7 && route.text.range(of:#"^[A-Za-z]{0,2}\s?\d{1,3}$"#,options:.regularExpression) != nil {
            // A second low-confidence pass does not require rereading an already accepted glyph.
            if eligible.contains(where: { $0.score>=0.7 && VehicleTextRules.normalize($0.text)==VehicleTextRules.normalize(route.text)
                && VehicleTracker.iou($0.box,route.box)>0.5 }) { continue }
            guard eligible.contains(where: { t in
                t.text.rangeOfCharacter(from:.letters) != nil && t.box.minX>=route.box.maxX
                    && t.box.minX-route.box.maxX<=max(t.box.height,route.box.height)*2
                    && abs(t.box.midY-route.box.midY)<=max(t.box.height,route.box.height)*0.3
                    && t.box.height/route.box.height>=0.5 && t.box.height/route.box.height<=1.8
            }) else { continue }
            if !routes.contains(where: { VehicleTextRules.normalize($0.text)==VehicleTextRules.normalize(route.text)
                && VehicleTracker.iou($0.box,route.box)>0.8 }) { routes.append(route) }
        }
        guard routes.count==1,let route=routes.first else { return nil }
        return route.box.insetBy(dx:-route.box.height*0.2,dy:-route.box.height*0.25).intersection(detection.box)
    }

    /// Where the second recognizer may read without an accepted Vision route numeral (docs/ar-recognition-plan.md,
    /// step 3): Vision's own low-confidence lines (0.3–0.7) in this vehicle's display band, the tallest two. A far
    /// display whose numeral Vision cannot accept otherwise never gets the second reader at all. Destination lines
    /// only: a line holding a route numeral is the route re-read's (VehicleRouteRecognitionPolicy), with its stricter
    /// gates; this path never supplies a line number.
    static let unanchoredLines = 2
    static func unanchoredRegions(_ texts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect]) -> [CGRect] {
        var regions: [CGRect] = []
        let eligible = texts.filter { t in
            t.score.isFinite && t.score >= 0.3 && t.score < 0.7 && t.box.width >= t.box.height
                && Self.destinationOnly(t.text)
                && t.box.midY < detection.box.minY + detection.box.height * 0.65
                && associated(t.box, detection: detection, otherBoxes: otherBoxes)
        }.sorted { $0.box.height > $1.box.height }
        for t in eligible where !regions.contains(where: { VehicleTracker.iou($0, t.box) > 0.5 }) {
            regions.append(t.box)
            if regions.count == unanchoredLines { break }
        }
        return regions
    }

    /// An unanchored re-read as display text for the unchanged matcher (never a reading by itself): only from this
    /// pinned engine, for this frame and track, complete (one score per character), at least two characters, every
    /// character ≥ 0.5 and their mean ≥ 0.95 (the engine's development policy above). Its score is that mean.
    static func unanchoredText(_ o: AlternativeDisplayObservation, trackID: UUID, frameID: UUID, at: Date) -> VehicleText? {
        guard o.engineID == engineID, o.modelID == modelID, o.configID == configID,
              o.trackID == trackID, o.frameID == frameID, o.capturedAt == at,
              o.characterScores.count == o.text.count, destinationOnly(o.text),
              o.characterScores.allSatisfy({ $0.isFinite && $0 >= 0.5 && $0 <= 1 }) else { return nil }
        let mean = o.characterScores.reduce(0, +) / Float(o.characterScores.count)
        return mean >= 0.95 ? VehicleText(text: o.text, box: o.region, score: mean) : nil
    }

    /// At least three letters and nothing the matcher would take for a route numeral ("10", "N1", "10E", "1O", and
    /// "9" of "9Wankdorf": checked with the matcher's own tokenizer, DisplayText.words).
    static func destinationOnly(_ text: String) -> Bool {
        guard text.filter(\.isLetter).count >= 3 else { return false }
        let tokens = DisplayText.words(text)
        if tokens.contains(where: { DisplayText.isRouteToken($0) && $0.contains(where: \.isNumber) }) { return false }
        // a numeral misread with letters ("1O", "I0") is a route numeral too
        return !text.split(whereSeparator: { $0 == " " || $0 == "," }).contains { word in
            String(word).range(of: #"^[0-9][0-9OoIl]{0,2}$"#, options: .regularExpression) != nil
                || String(word).range(of: #"^[OoIl][0-9]{1,2}$"#, options: .regularExpression) != nil
        }
    }

    static func associated(_ box: CGRect, detection: VehicleDetection, otherBoxes: [CGRect]) -> Bool {
        guard [box.minX,box.minY,box.width,box.height].allSatisfy(\.isFinite), !box.isEmpty,
              detection.box.contains(box), !otherBoxes.contains(where: { $0.intersects(box) }) else { return false }
        return [CGPoint(x:box.minX,y:box.midY),CGPoint(x:box.midX,y:box.midY),CGPoint(x:box.maxX,y:box.midY)]
            .allSatisfy { detection.mask.contains($0) }
    }

    /// Explicit DEVELOPMENT policy for this pinned engine: complete greedy character evidence,
    /// mean >=.95 and every emitted character >=.50, plus the spatial and temporal constraints
    /// below. These are engine-specific raw-score gates, NOT Vision .7 or calibrated accuracy.
    /// Distinct actual frame accumulation remains the unchanged matcher's responsibility.
    static func reading(_ observations: [AlternativeDisplayObservation], proposal: Proposal,
                        visionTexts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect],
                        trackID: UUID, frameID: UUID, at: Date, layout: VehicleDisplayLayout = .routeFirst) -> DisplayReading? {
        guard at.timeIntervalSince1970.isFinite,
              let current = self.proposal(visionTexts,detection:detection,otherBoxes:otherBoxes,layout:layout),
              current.region == proposal.region, current.route.box == proposal.route.box,
              current.route.text == proposal.route.text else { return nil }
        // The newly supported right-hand-route layout has no validated weak-character
        // headsign allowance. Require every emitted character to meet the stricter gate.
        // Preserve the existing left-hand-route engine policy for the baseline.
        let minimumCharacter: Float = layout == .eitherSide && proposal.headsign.box.maxX <= proposal.route.box.minX ? 0.98 : 0.5
        let accepted = observations.filter { o in
            guard o.engineID == engineID, o.modelID == modelID, o.configID == configID,
                  o.frameID == frameID, o.trackID == trackID, o.capturedAt == at,
                  o.region == proposal.region, !o.samplingID.isEmpty,
                  o.characterScores.count == o.text.count, o.text.count >= 4,
                  o.text.rangeOfCharacter(from:.letters) != nil,
                  o.characterScores.allSatisfy({ $0.isFinite && $0 >= minimumCharacter && $0 <= 1 }) else { return false }
            return o.characterScores.reduce(0,+)/Float(o.characterScores.count) >= 0.95
        }
        guard !accepted.isEmpty else { return nil }
        let values = Set(accepted.map { VehicleTextRules.normalize($0.text) })
        let vision = VehicleTextRules.read(visionTexts,detection:detection,otherBoxes:otherBoxes,at:at,frameID:frameID,layout:layout)
        // Existing accepted Vision evidence always retains its veto, including service closure.
        if vision.outOfService || vision.ambiguous { return vision }
        let line = VehicleTextRules.normalize(proposal.route.text).replacingOccurrences(of:" ",with:"")
        let destination = values.first!
        let contradicted = visionTexts.contains { t in
            t.score >= 0.7 && associated(t.box,detection:detection,otherBoxes:otherBoxes)
                && VehicleTracker.iou(t.box,proposal.region)>0.5
                && VehicleTextRules.normalize(t.text) != destination
        } || (vision.line != nil && (vision.line != line || vision.destination != destination))
        let ambiguous = values.count != 1 || contradicted
        let raw = vision.raw + accepted.map(\.text)
        let closed = raw.contains { text in
            ["ausser betrieb","nicht einsteigen","dienstfahrt","extrafahrt","out of service","not in service","depot","garage"]
                .contains { VehicleTextRules.normalize(text).contains($0) }
        }
        return DisplayReading(frameID:frameID,at:at,line:ambiguous ? nil:line,destination:ambiguous ? nil:destination,
            outOfService:closed,ambiguous:ambiguous,raw:raw)
    }
}

enum VehicleDisplayCTC {
    struct Result { let text: String; let characterScores: [Float] }
    /// Greedy CTC: blank0, collapse repeated indices only before removing blanks. The original
    /// dictionary includes spaces; no language model, lexicon or expected-text repair is used.
    static func decode(_ values: [Float], steps: Int, dictionary: [String]) -> Result? {
        guard steps>0, steps<=1024, dictionary.count>1, dictionary.first == "",
              values.count == steps*dictionary.count, values.allSatisfy({ $0.isFinite && $0>=0 && $0<=1 }) else { return nil }
        var text = "", scores: [Float] = [], previous = -1
        for step in 0..<steps {
            let base = step*dictionary.count
            // Match NumPy/ORT reference argmax: first class wins an exact tie.
            var index = 0
            for candidate in 1..<dictionary.count where values[base+candidate]>values[base+index] { index = candidate }
            if index != 0 && index != previous {
                guard dictionary[index].count == 1 else { return nil }
                text += dictionary[index];scores.append(values[base+index])
            }
            previous = index
        }
        return Result(text:text,characterScores:scores)
    }
}

/// Experimental second-engine route reading. A weak observed numeral only proposes pixels;
/// accepted text must independently agree, with complete engine-specific character evidence.
/// Correlated crops are one frame and never satisfy the temporal matcher on their own.
enum VehicleRouteRecognitionPolicy {
    struct Proposal { let route: VehicleText; let destination: VehicleText }
    static func proposal(_ texts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect]) -> Proposal? {
        let eligible = texts.filter { $0.score.isFinite && $0.score >= 0.3
            && VehicleDisplayRecognitionPolicy.associated($0.box, detection: detection, otherBoxes: otherBoxes)
            && $0.box.midY < detection.box.minY + detection.box.height * 0.65 }
        var pairs: [Proposal] = []
        for route in eligible where route.score < 0.7
            && route.text.range(of: #"^[A-Za-z]{0,2}\s?\d{1,3}$"#, options: .regularExpression) != nil {
            for destination in eligible where destination.score >= 0.7
                && VehicleTextRules.adjacentDestination(destination, to: route, layout: .eitherSide) {
                if !pairs.contains(where: { VehicleTextRules.normalize($0.route.text) == VehicleTextRules.normalize(route.text)
                    && VehicleTextRules.normalize($0.destination.text) == VehicleTextRules.normalize(destination.text)
                    && VehicleTracker.iou($0.route.box, route.box) > 0.5 }) {
                    pairs.append(Proposal(route: route, destination: destination))
                }
            }
        }
        return pairs.count == 1 ? pairs[0] : nil
    }
    static func reading(_ observations: [AlternativeDisplayObservation], proposal: Proposal, texts: [VehicleText],
                        detection: VehicleDetection, otherBoxes: [CGRect], trackID: UUID, frameID: UUID, at: Date) -> DisplayReading? {
        guard let current = self.proposal(texts, detection: detection, otherBoxes: otherBoxes),
              current.route.box == proposal.route.box, current.route.text == proposal.route.text,
              current.destination.box == proposal.destination.box, current.destination.text == proposal.destination.text else { return nil }
        let vision = VehicleTextRules.read(texts, detection: detection, otherBoxes: otherBoxes, at: at, frameID: frameID, layout: .eitherSide)
        guard !vision.ambiguous, !vision.outOfService, vision.line == nil, vision.destination == nil else { return nil }
        let accepted = observations.filter { o in
            o.engineID == VehicleDisplayRecognitionPolicy.engineID && o.modelID == VehicleDisplayRecognitionPolicy.modelID
                && o.configID == VehicleDisplayRecognitionPolicy.configID && o.frameID == frameID && o.trackID == trackID
                && o.capturedAt == at && o.region == proposal.route.box && o.samplingID.hasPrefix("route-")
                && !o.text.isEmpty && o.text.count == o.characterScores.count
                && o.text.range(of: #"^[A-Za-z]{0,2}\s?\d{1,3}$"#, options: .regularExpression) != nil
                && o.characterScores.allSatisfy { $0.isFinite && $0 >= 0.98 && $0 <= 1 }
        }
        guard !accepted.isEmpty else { return nil }
        let expectedObservation = VehicleTextRules.normalize(proposal.route.text).replacingOccurrences(of: " ", with: "")
        let values = Set(accepted.map { VehicleTextRules.normalize($0.text).replacingOccurrences(of: " ", with: "") })
        guard values.count == 1, values.first == expectedObservation else { return nil }
        // Any confidently observed competing numeral anywhere in the upper display vetoes this attempt.
        guard !texts.contains(where: { $0.score >= 0.7
            && $0.text.range(of: #"^[A-Za-z]{0,2}\s?\d{1,3}$"#, options: .regularExpression) != nil
            && VehicleDisplayRecognitionPolicy.associated($0.box, detection: detection, otherBoxes: otherBoxes)
            && $0.box.midY < detection.box.minY + detection.box.height * 0.65
            && VehicleTextRules.normalize($0.text).replacingOccurrences(of: " ", with: "") != expectedObservation }) else { return nil }
        return DisplayReading(frameID: frameID, at: at, line: expectedObservation,
            destination: VehicleTextRules.normalize(proposal.destination.text), outOfService: false, ambiguous: false,
            raw: vision.raw + accepted.map(\.text))
    }
}
