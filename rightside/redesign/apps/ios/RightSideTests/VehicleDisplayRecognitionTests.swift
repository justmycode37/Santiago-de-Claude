import XCTest
#if canImport(RightSide)
@testable import RightSide
#endif

final class VehicleDisplayRecognitionTests: XCTestCase {
    func testMissingModelDictionaryAndInitializationStayOneShot() {
        for (model, dictionary, issue) in [(false, true, DisplayRecognitionIssue.missingModel), (true, false, .missingDictionary)] {
            var state = DisplayRecognitionLoadState()
            XCTAssertFalse(state.begin(modelPresent: model, dictionaryPresent: dictionary))
            XCTAssertEqual(state.issue, issue)
            for _ in 0..<3 { XCTAssertFalse(state.begin(modelPresent: true, dictionaryPresent: true)); XCTAssertEqual(state.issue, issue) }
        }
        var rejected = DisplayRecognitionLoadState()
        XCTAssertTrue(rejected.begin(modelPresent: true, dictionaryPresent: true))
        rejected.rejectInitialization()
        for _ in 0..<3 { XCTAssertFalse(rejected.begin(modelPresent: true, dictionaryPresent: true)); XCTAssertEqual(rejected.issue, .initializationFailed) }
    }
    func testReadyLoaderDoesNotReloadOrInventFailure() {
        var state = DisplayRecognitionLoadState()
        XCTAssertTrue(state.begin(modelPresent: true, dictionaryPresent: true)); XCTAssertNil(state.issue)
        XCTAssertFalse(state.begin(modelPresent: true, dictionaryPresent: true)); XCTAssertNil(state.issue)
    }

    private let at = Date(timeIntervalSince1970:1_800_000_000)
    private let trackID = UUID(), frameID = UUID()
    private var detection: VehicleDetection {
        .init(kind:.tram,box:CGRect(x:0.1,y:0.1,width:0.8,height:0.8),score:0.9,
              mask:.init(width:100,height:100,pixels:Array(repeating:1,count:10_000)))
    }
    private var texts: [VehicleText] {
        [.init(text:"8",box:CGRect(x:0.2,y:0.2,width:0.04,height:0.06),score:0.99),
         .init(text:"Brünnen Lestside Bhf",box:CGRect(x:0.26,y:0.21,width:0.3,height:0.04),score:0.5)]
    }
    private func observation(_ text:String="Brünnen Westside Bhf",scores:[Float]?=nil,at:Date?=nil,
                             frame:UUID?=nil,track:UUID?=nil,engine:String?=nil) -> AlternativeDisplayObservation {
        .init(engineID:engine ?? VehicleDisplayRecognitionPolicy.engineID,modelID:VehicleDisplayRecognitionPolicy.modelID,
            configID:VehicleDisplayRecognitionPolicy.configID,frameID:frame ?? frameID,capturedAt:at ?? self.at,
            trackID:track ?? trackID,text:text,characterScores:scores ?? Array(repeating:0.98,count:text.count),
            region:texts[1].box,samplingID:"native")
    }
    private func reading(_ observations:[AlternativeDisplayObservation],texts:[VehicleText]?=nil,frame:UUID?=nil,at:Date?=nil) throws -> DisplayReading? {
        let texts = texts ?? self.texts
        let proposal = try XCTUnwrap(VehicleDisplayRecognitionPolicy.proposal(texts,detection:detection,otherBoxes:[]))
        return VehicleDisplayRecognitionPolicy.reading(observations,proposal:proposal,visionTexts:texts,detection:detection,
            otherBoxes:[],trackID:trackID,frameID:frame ?? frameID,at:at ?? self.at)
    }
    func testAcceptedAlternativeRetainsObservedSpellingAndNoVisionScoreMutation() throws {
        let result = try XCTUnwrap(reading([observation()]))
        XCTAssertEqual(result.line,"8");XCTAssertEqual(result.destination,"brunnen westside bhf")
        XCTAssertEqual(result.displayText,"8 Brünnen Westside Bhf")
        XCTAssertEqual(texts[1].score,0.5)
        XCTAssertEqual(result.at,at);XCTAssertEqual(result.frameID,frameID)
    }
    func testNoRouteAnchorMeansAdsAndDestinationOnlyCannotPropose() {
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal([texts[1]],detection:detection,otherBoxes:[]))
        let ads = [VehicleText(text:"SALE NOW",box:texts[0].box,score:1),texts[1]]
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(ads,detection:detection,otherBoxes:[]))
    }
    func testOriginalVisionNumeralThresholdRemainsRequired() {
        var input = texts;input[0] = .init(text:"8",box:texts[0].box,score:0.69)
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(input,detection:detection,otherBoxes:[]))
    }
    func testPlateZoneAndUnrelatedRowsCannotPropose() {
        let plate = texts.map { VehicleText(text:$0.text,box:$0.box.offsetBy(dx:0,dy:0.55),score:$0.score) }
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(plate,detection:detection,otherBoxes:[]))
        var separate = texts;separate[1] = .init(text:separate[1].text,box:separate[1].box.offsetBy(dx:0,dy:0.12),score:0.5)
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(separate,detection:detection,otherBoxes:[]))
    }
    func testAnotherVehicleOrMissingMaskBlocksProposal() {
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(texts,detection:detection,otherBoxes:[texts[1].box]))
        let noMask = VehicleDetection(kind:.tram,box:detection.box,score:0.9,mask:.init(width:100,height:100,pixels:Array(repeating:0,count:10_000)))
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(texts,detection:noMask,otherBoxes:[]))
    }
    func testAmbiguousRouteAnchorsAbstain() {
        let input = texts + [VehicleText(text:"9",box:texts[0].box,score:0.99)]
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(input,detection:detection,otherBoxes:[]))
    }
    func testMissingCharacterEvidenceAndUncalibratedWeakOutputRefused() throws {
        XCTAssertNil(try reading([observation(scores:[0.99])]))
        XCTAssertNil(try reading([observation(scores:Array(repeating:0.94,count:"Brünnen Westside Bhf".count))]))
        var scores = Array(repeating:Float(0.99),count:"Brünnen Westside Bhf".count);scores[0] = 0.49
        XCTAssertNil(try reading([observation(scores:scores)]))
        scores[0] = .nan;XCTAssertNil(try reading([observation(scores:scores)]))
    }
    func testNumberOnlyAndBlankTextureOutputNeverSuppliesDestination() throws {
        XCTAssertNil(try reading([observation("901")]))
        XCTAssertNil(try reading([observation("ETY",scores:[0.405,0.402,0.553])]))
        XCTAssertNil(try reading([observation("")]))
    }
    func testWrongEngineInstanceFrameOrFutureObservationRefused() throws {
        XCTAssertNil(try reading([observation(engine:"different-unvalidated-model")]))
        XCTAssertNil(try reading([observation(track:UUID())]))
        XCTAssertNil(try reading([observation(frame:UUID())]))
        XCTAssertNil(try reading([observation(at:at.addingTimeInterval(1))]))
    }
    func testConfidentVisionContradictionCannotBeOverwritten() throws {
        let input = texts + [VehicleText(text:"Different Terminus",box:texts[1].box,score:0.99)]
        let result = try XCTUnwrap(reading([observation()],texts:input))
        XCTAssertTrue(result.ambiguous);XCTAssertNil(result.line);XCTAssertNil(result.destination)
    }
    func testConflictingAcceptedAlternativeOutputsAbstain() throws {
        let result = try XCTUnwrap(reading([observation(),observation("Different Terminus")]))
        XCTAssertTrue(result.ambiguous);XCTAssertNil(result.destination)
    }
    func testOutOfServiceRetainsVeto() throws {
        let result = try XCTUnwrap(reading([observation("Out of service")]))
        XCTAssertTrue(result.outOfService)
    }
    func testCorrelatedSamplesDoNotReplaceDistinctFrameTemporalEvidence() throws {
        let repeated = try XCTUnwrap(reading([observation(),observation()]))
        let track = VehicleTrack(id:trackID,detection:detection,lastSeen:at,readings:[repeated,repeated,repeated])
        XCTAssertEqual(VehicleServiceMatcher.decide(track,expected:.init(line:"8",destination:"Brünnen Westside Bhf"),now:at).state,.unknown)
        var readings:[DisplayReading] = []
        for offset in [0.0,0.4,0.85] {
            let date = at.addingTimeInterval(offset), frame = UUID()
            readings.append(try XCTUnwrap(reading([observation(at:date,frame:frame)],frame:frame,at:date)))
        }
        let stable = VehicleTrack(id:trackID,detection:detection,lastSeen:at.addingTimeInterval(0.85),readings:readings)
        XCTAssertEqual(VehicleServiceMatcher.decide(stable,expected:.init(line:"8",destination:"Brünnen Westside Bhf"),now:stable.lastSeen).state,.visualCandidate)
        XCTAssertEqual(VehicleServiceMatcher.decide(stable,expected:.init(line:"9",destination:"Brünnen Westside Bhf"),now:stable.lastSeen).state,.conflicting)
    }
    func testWeakAdjacentPairOnlyProposesReReadingNeverAcceptedIdentity() {
        let input = texts.map { VehicleText(text:$0.text,box:$0.box,score:0.5) }
        XCTAssertNotNil(VehicleDisplayRecognitionPolicy.glyphRefinementRegion(input,detection:detection,otherBoxes:[]))
        XCTAssertNil(VehicleDisplayRecognitionPolicy.proposal(input,detection:detection,otherBoxes:[]))
        XCTAssertNil(VehicleDisplayRecognitionPolicy.glyphRefinementRegion(input+[texts[0]],detection:detection,otherBoxes:[]))
        XCTAssertNil(VehicleDisplayRecognitionPolicy.glyphRefinementRegion(input,detection:detection,otherBoxes:[input[0].box]))
        XCTAssertNil(VehicleDisplayRecognitionPolicy.glyphRefinementRegion([input[0]],detection:detection,otherBoxes:[]))
        XCTAssertNil(VehicleDisplayRecognitionPolicy.glyphRefinementRegion(input.map { .init(text:$0.text,box:$0.box,score:0.29) },detection:detection,otherBoxes:[]))
    }
    func testFailedAlternativeWritesUnreadableCurrentFrameInsteadOfKeepingPositive() throws {
        var tracker = VehicleTracker()
        for offset in [0.0,0.4,0.85] {
            let date = at.addingTimeInterval(offset),frame = UUID()
            tracker.update([detection],at:date)
            let id = try XCTUnwrap(tracker.tracks.first?.id)
            let observed = AlternativeDisplayObservation(engineID:VehicleDisplayRecognitionPolicy.engineID,modelID:VehicleDisplayRecognitionPolicy.modelID,
                configID:VehicleDisplayRecognitionPolicy.configID,frameID:frame,capturedAt:date,trackID:id,text:"Brünnen Westside Bhf",
                characterScores:Array(repeating:0.99,count:"Brünnen Westside Bhf".count),region:texts[1].box,samplingID:"native")
            let proposal = try XCTUnwrap(VehicleDisplayRecognitionPolicy.proposal(texts,detection:detection,otherBoxes:[]))
            let reading = try XCTUnwrap(VehicleDisplayRecognitionPolicy.reading([observed],proposal:proposal,visionTexts:texts,detection:detection,
                otherBoxes:[],trackID:id,frameID:frame,at:date))
            tracker.record(reading,trackID:id)
        }
        let expected = VehicleServiceExpectation(line:"8",destination:"Brünnen Westside Bhf")
        XCTAssertEqual(VehicleServiceMatcher.decide(try XCTUnwrap(tracker.tracks.first),expected:expected,now:at.addingTimeInterval(0.85)).state,.visualCandidate)
        let date = at.addingTimeInterval(1.2)
        tracker.update([detection],at:date)
        let id = try XCTUnwrap(tracker.tracks.first?.id)
        // This is the production fallback when native crop preprocessing throws/returns no observation.
        tracker.record(VehicleTextRules.read(texts,detection:detection,otherBoxes:[],at:date,frameID:UUID()),trackID:id)
        let current = try XCTUnwrap(tracker.tracks.first)
        XCTAssertEqual(current.id,id);XCTAssertNil(current.readings.last?.displayText)
        XCTAssertEqual(VehicleServiceMatcher.decide(current,expected:expected,now:date).state,.unknown)
    }
    func testCTCBlankAndRepeatedCharactersFollowOriginalContract() throws {
        let dictionary = ["","a","b"," "]
        var values = Array(repeating:Float(0),count:6*dictionary.count)
        for (row,index) in [1,1,0,1,3,2].enumerated() { values[row*dictionary.count+index] = 0.99 }
        let result = try XCTUnwrap(VehicleDisplayCTC.decode(values,steps:6,dictionary:dictionary))
        XCTAssertEqual(result.text,"aa b");XCTAssertEqual(result.characterScores.count,4)
        XCTAssertNil(VehicleDisplayCTC.decode(values,steps:5,dictionary:dictionary))
        XCTAssertEqual(VehicleDisplayCTC.decode([0.5,0.5,0,0],steps:1,dictionary:dictionary)?.text,"")
        values[0] = .nan;XCTAssertNil(VehicleDisplayCTC.decode(values,steps:6,dictionary:dictionary))
    }
}
