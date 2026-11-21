import Foundation
import CoreImage
import ImageIO

/// Actual model/Vision pixels; controlled still arrangements and replay clock, NOT video truth.
@main struct MultimodalReplay {
    static func main() throws {
        let a = CommandLine.arguments
        guard a.count == 7 else { exit(2) }
        let model = URL(fileURLWithPath:a[1]), images = URL(fileURLWithPath:a[2]), out = URL(fileURLWithPath:a[3])
        let baseline = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath:a[4]))) as! [String:Any]
        let oldFrames = baseline["frames"] as! [[String:Any]]
        let context = CIContext(options:[.cacheIntermediates:false])
        let clock = Date(timeIntervalSince1970:1_800_000_000)
        let pipeline = LocalVehiclePipeline(modelURL:model,displayModelURL:URL(fileURLWithPath:a[5]),displayCharactersURL:URL(fileURLWithPath:a[6]))
        if ProcessInfo.processInfo.environment["CAMERA_TRACE"] == "1" { pipeline.trace = { print($0) } }
        var failures:[String] = [], checks = 0, rows:[[String:Any]] = [], fixtureRows:[[String:Any]] = []
        func check(_ value:Bool,_ label:String) { checks += 1; if !value { failures.append(label) }; print("\(value ? "PASS" : "FAIL") \(label)"); fflush(stdout) }
        func source(_ name:String, maximum:Double=2560) -> CIImage {
            let input = CIImage(contentsOf:images.appendingPathComponent(name+".jpg"))!
            let s = min(1,maximum/max(input.extent.width,input.extent.height))
            return input.transformed(by:CGAffineTransform(scaleX:s,y:s))
        }
        func composite(_ names:[String],columns:Int) -> CIImage {
            let w = 2560.0/Double(columns), h = w*0.8, countRows = Int(ceil(Double(names.count)/Double(columns)))
            let bounds = CGRect(x:0,y:0,width:2560,height:h*Double(countRows))
            var canvas = CIImage(color:CIColor(red:0.3,green:0.3,blue:0.3)).cropped(to:bounds)
            for (i,name) in names.enumerated() {
                let original = source(name)
                let frame = oldFrames.first { $0["sample"] as? String == name }!
                let box = ((frame["tracks"] as! [[String:Any]])[0]["box"] as! [Double])
                let normalized = CGRect(x:box[0],y:box[1],width:box[2],height:box[3])
                // Old actual detection is used ONLY for fixture preparation. The new detector
                // receives finished pixels, never these boxes, source labels or expectations.
                let crop = CGRect(x:normalized.minX*original.extent.width,y:(1-normalized.maxY)*original.extent.height,
                    width:normalized.width*original.extent.width,height:normalized.height*original.extent.height)
                    .insetBy(dx:-original.extent.width*0.015,dy:-original.extent.height*0.015).integral.intersection(original.extent)
                let scale = min((w-48)/crop.width,(h-48)/crop.height)
                let x = Double(i%columns)*w+(w-crop.width*scale)/2
                let y = Double(countRows-1-i/columns)*h+(h-crop.height*scale)/2
                let tile = original.cropped(to:crop).transformed(by:CGAffineTransform(translationX:-crop.minX,y:-crop.minY))
                    .transformed(by:CGAffineTransform(scaleX:scale,y:scale)).transformed(by:CGAffineTransform(translationX:x,y:y))
                canvas = tile.composited(over:canvas)
                fixtureRows.append(["sources":names,"tile":i,"original":name,"sourceCropPixels":[crop.minX,crop.minY,crop.width,crop.height],
                    "outputRectangle":[x,y,crop.width*scale,crop.height*scale],"displayPixelsEdited":false])
            }
            return canvas.cropped(to:bounds)
        }
        func expected(_ line:String,_ destination:String,at:Date) -> VehicleServiceExpectation {
            .init(line:line,destination:destination,boardingStopID:"synthetic-board",alightingStopID:"synthetic-alight",
                validUntil:at.addingTimeInterval(30),requiresRouteContext:true,revision:1,observedAt:at,
                boardingCallID:"board-call",alightingCallID:"alight-call",
                downstreamCalls:[.init(id:"alight-call",stopID:"synthetic-alight",name:destination)])
        }
        func overlays(_ result:VehicleFrameResult,_ expectation:VehicleServiceExpectation,_ at:Date) -> [CameraVehicleOverlay] {
            result.tracks.map { .init(id:$0.id,box:$0.detection.box,maskRuns:$0.detection.mask.runs,title:$0.detection.kind.rawValue,
                decision:VehicleServiceMatcher.decide($0,expected:expectation,now:at),displayText:$0.readings.last?.displayText,capturedAt:$0.readings.last?.at) }
        }
        func frame(_ input:CIImage,_ name:String,_ state:inout CameraEvidenceLifecycle,_ expectation:VehicleServiceExpectation,_ at:Date) throws -> VehicleFrameResult {
            if state.feedbackExpired(at:at) { state.invalidate(.expired,at:at) }
            let result = try pipeline.process(upright:input,at:at,epoch:state.trackingEpoch)
            let incoming = overlays(result,expectation,at)
            let published = state.publish(vehicles:incoming,matches:[],token:state.epoch,capturedAt:at,now:at,routeValidUntil:expectation.validUntil)
            let tracks:[[String:Any]] = result.tracks.map { t in
                let before = incoming.first { $0.id == t.id }!, after = state.vehicles.first { $0.id == t.id }
                let diagnostic = result.recognitionDiagnostics.first { $0.trackID == t.id }
                let observed = diagnostic?.alternative
                return ["visionTexts":diagnostic?.visionTexts.map { t -> [String:Any] in ["text":t.text,"score":t.score,"box":[t.box.minX,t.box.minY,t.box.width,t.box.height]] } ?? [],
                    "alternative":observed.map { o -> [String:Any] in ["engineID":o.engineID,"modelID":o.modelID,"configID":o.configID,
                        "frameID":o.frameID.uuidString,"capturedAt":o.capturedAt.timeIntervalSince1970,"text":o.text,
                        "samplingID":o.samplingID,"characterScores":o.characterScores,"region":[o.region.minX,o.region.minY,o.region.width,o.region.height]] } as Any? ?? NSNull(),
                    "additionalAlternatives":diagnostic?.additionalAlternatives.map { o -> [String:Any] in
                        ["engineID":o.engineID,"modelID":o.modelID,"configID":o.configID,"frameID":o.frameID.uuidString,
                        "capturedAt":o.capturedAt.timeIntervalSince1970,"text":o.text,"samplingID":o.samplingID,
                        "characterScores":o.characterScores,"region":[o.region.minX,o.region.minY,o.region.width,o.region.height]] } ?? [],
                    "proposalRejectionReason":diagnostic?.proposalRejectionReason as Any? ?? NSNull(),
                    "fallbackFailure":diagnostic?.fallbackFailure as Any? ?? NSNull(),"id":t.id.uuidString,"class":t.detection.kind.rawValue,"score":t.detection.score,
                    "box":[t.detection.box.minX,t.detection.box.minY,t.detection.box.width,t.detection.box.height],
                    "maskPixelCount":t.detection.mask.pixels.filter { $0 != 0 }.count,
                    "rawText":t.readings.last?.raw ?? [],"observedDisplay":t.readings.last?.displayText as Any? ?? NSNull(),
                    "ocrAge":t.readings.last.map { at.timeIntervalSince($0.at) } as Any? ?? NSNull(),
                    "readingCount":t.readings.count,"matchState":before.decision.state.rawValue,"matchReason":before.decision.reason,
                    "publishedState":after?.decision.state.rawValue as Any? ?? NSNull(),"publishedReason":after?.decision.reason as Any? ?? NSNull()]
            }
            rows.append(["name":name,"at":at.timeIntervalSince(clock),"pixels":[input.extent.width,input.extent.height],
                "actualMacMS":result.latencyMS,"wouldMeet700msGate":result.latencyMS<700,"replayPublicationAccepted":published,
                "candidateID":state.candidateID?.uuidString as Any? ?? NSNull(),"instruction":state.recognition,"tracks":tracks,
                "lostIDs":result.lost.map(\.uuidString)])
            check(published,name+" deterministic publication accepted")
            check(incoming.allSatisfy { $0.decision.state != .verifiedService },name+" no manufactured binding")
            if name.hasSuffix("-2") || name.hasSuffix("occluded") || name.hasSuffix("loss") || name.hasSuffix("reentry2") || name == "six-arranged-5" {
                try draw(input,state.vehicles,context,out.appendingPathComponent(name+".png"))
            }
            return result
        }
        let scenarios:[(String,CIImage,String,String,Int)] = [
            ("bus1280",source("bus",maximum:1280),"12","Bern Bahnhof",1),
            ("bus2560",source("bus"),"12","Bern Bahnhof",1),
            ("tram1280",source("tram",maximum:1280),"8","Brünnen Westside Bhf",1),
            ("tram2560",source("tram"),"8","Brünnen Westside Bhf",1),
            ("bus-tram",composite(["bus","tram"],columns:2),"12","Bern Bahnhof",2),
            ("two-buses",composite(["bus","bus"],columns:2),"12","Bern Bahnhof",2)]
        for (i,scenario) in scenarios.enumerated() {
            let (name,input,line,destination,count) = scenario, start = clock.addingTimeInterval(Double(i)*10)
            let selection = expected(line,destination,at:start)
            var state = CameraEvidenceLifecycle();state.start(at:start)
            var last:VehicleFrameResult!
            for (f,offset) in [0.0,0.4,0.85].enumerated() { last = try frame(input,name+"-\(f)",&state,selection,start.addingTimeInterval(offset)) }
            let at = start.addingTimeInterval(0.85), decisions = overlays(last,selection,at)
            check(last.tracks.count == count,name+" actual instance count")
            check(last.tracks.allSatisfy { !$0.detection.mask.runs.isEmpty },name+" actual instance masks")
            if name == "two-buses" {
                check(decisions.count == 2 && decisions.allSatisfy { $0.decision.state == .visualCandidate },name+" two real-pixel display candidates")
                check(state.candidateID == nil && state.vehicles.count == 2 && state.vehicles.allSatisfy { $0.decision.reason == "multiple_matching_vehicles" },name+" ambiguous unique highlight suppressed")
            } else {
                check(state.candidateID != nil,name+" useful stable visual candidate REQUIRED")
                if name == "bus-tram" {
                    check(decisions.count == 2 && decisions.filter { $0.decision.state == .visualCandidate && $0.box.midX<0.5 }.count == 1
                        && decisions.filter { $0.decision.state == .conflicting && $0.box.midX>0.5 }.count == 1,name+" correct and wrong service stay instance-specific")
                    var reversed = CameraEvidenceLifecycle();reversed.start(at:at)
                    _ = reversed.publish(vehicles:overlays(last,expected("8","Brünnen Westside Bhf",at:start),at),matches:[],token:reversed.epoch,capturedAt:at,now:at)
                    check(reversed.candidateID != nil && reversed.vehicles.first { $0.id == reversed.candidateID }!.box.midX>0.5,name+" selecting tram highlights only right instance")
                }
            }
            // v2 fixed denominator: utility plus ALL six context controls run for each
            // scenario, including two matching buses. Missing observed identity fails each
            // relevant control; it cannot remove checks or turn abstention into utility.
            let observedTrack = last.tracks.first(where: { $0.readings.last?.line == line })
            check(observedTrack != nil,name+" matching observed line required for negative controls")
            func observedDecision(_ expectation:VehicleServiceExpectation) -> VehicleDecision? {
                observedTrack.map { VehicleServiceMatcher.decide($0,expected:expectation,now:at) }
            }
            var wrong = expected("999",destination,at:start)
            check(observedDecision(wrong)?.state == .conflicting,name+" wrong line")
            wrong = expected(line,"Opposite Terminus",at:start)
            check(observedDecision(wrong)?.state == .conflicting,name+" opposite destination")
            wrong.downstreamCalls.insert(.init(id:"earlier",stopID:"earlier-stop",name:destination),at:0)
            check(observedDecision(wrong)?.reason == "display_short_turn_before_alighting",name+" short turn")
            for variant in ["stale","future","cancelled-alighting"] {
                var invalid = selection
                if variant == "stale" { invalid.validUntil = start }
                if variant == "future" { invalid.latestObservedAt = at.addingTimeInterval(1) }
                if variant == "cancelled-alighting" { invalid.alightingUnavailable = true }
                let decision = observedDecision(invalid)
                check(decision != nil && decision?.state != .visualCandidate && decision?.state != .verifiedService,name+" R3 "+variant)
            }
            // Actual pixel display occlusion; leave the other vehicle intact in two-instance input.
            if let target = last.tracks.min(by: { $0.detection.box.minX<$1.detection.box.minX }) {
                let b = target.detection.box
                let upper = CGRect(x:b.minX*input.extent.width,y:(1-b.minY-b.height*0.55)*input.extent.height,
                    width:b.width*input.extent.width,height:b.height*0.55*input.extent.height)
                let partial = CIImage(color:.black).cropped(to:upper).composited(over:input)
                let hidden = try frame(partial,name+"-display-occluded",&state,selection,start.addingTimeInterval(1.25))
                check(hidden.tracks.filter { $0.detection.box.midX == b.midX || VehicleTracker.iou($0.detection.box,b)>0.3 }
                    .allSatisfy { VehicleServiceMatcher.decide($0,expected:selection,now:start.addingTimeInterval(1.25)).state != .visualCandidate },name+" occluded display cannot retain positive")
            } else {
                check(false,name+"-display-occluded deterministic publication accepted")
                check(false,name+"-display-occluded no manufactured binding")
                check(false,name+" occluded display cannot retain positive")
            }
            let black = CIImage(color:.black).cropped(to:input.extent)
            let lost = try frame(black,name+"-full-loss",&state,selection,start.addingTimeInterval(1.65))
            check(lost.tracks.isEmpty && state.candidateID == nil,name+" full disappearance clears positive")
            let oldIDs = Set(last.tracks.map(\.id))
            var recovered:VehicleFrameResult!
            for (f,offset) in [2.05,2.45,2.9].enumerated() { recovered = try frame(input,name+"-reentry\(f)",&state,selection,start.addingTimeInterval(offset)) }
            check(Set(recovered.tracks.map(\.id)).isDisjoint(with:oldIDs),name+" reentry does not inherit disappeared IDs")
            check(name == "two-buses" ? (state.candidateID == nil && state.vehicles.filter { $0.decision.reason == "multiple_matching_vehicles" }.count == 2) : state.candidateID != nil,name+" useful positive or explicit two-match abstention recovers")
            if name == "bus-tram" {
                // Abrupt controlled rearrangement, NOT a physical crossing trajectory.
                let beforeSwap = Set(recovered.tracks.map(\.id)), swapped = composite(["tram","bus"],columns:2)
                for (f,offset) in [3.3,3.7,4.15].enumerated() { recovered = try frame(swapped,name+"-swapped\(f)",&state,selection,start.addingTimeInterval(offset)) }
                check(recovered.tracks.count == 2 && Set(recovered.tracks.map(\.id)).isDisjoint(with:beforeSwap),name+" controlled class/position swap discards old instance IDs")
                check(state.candidateID != nil && state.vehicles.first { $0.id == state.candidateID }!.box.midX>0.5,name+" useful matching display recovers on new side")
            }
        }
        let crowded = composite(["bus","tram","bus","tram","bus","tram"],columns:3)
        var crowdedState = CameraEvidenceLifecycle();crowdedState.start(at:clock.addingTimeInterval(100))
        var crowdResults:[VehicleFrameResult] = []
        for f in 0..<6 { crowdResults.append(try frame(crowded,"six-arranged-\(f)",&crowdedState,expected("12","Bern Bahnhof",at:clock.addingTimeInterval(100)),clock.addingTimeInterval(100+Double(f)*0.21))) }
        check(crowdResults.allSatisfy { $0.tracks.count <= 6 },"crowded pixels bounded track count")
        if let final = crowdResults.last {
            check(final.tracks.allSatisfy { !$0.readings.isEmpty },"every actually retained crowd instance receives round-robin OCR")
            print("COVERAGE six-arranged actual final track count \(final.tracks.count); missing instances are a detector limitation, not six-track validation")
        }
        let expectedChecks = 205
        if checks != expectedChecks { failures.append("fixed v2 denominator mismatch: expected 205, observed \(checks)") }
        let report:[String:Any] = ["schemaVersion":2,"contractVersion":"development-pixels-v2-fixed205",
            "expectedChecks":expectedChecks,"denominatorConforms":checks == expectedChecks,"checks":checks,"failures":failures,"frames":rows,"controlledCompositePreparation":fixtureRows,
            "independentPhotos":2,"newHeldoutPhotos":0,"fieldEncounters":0,"physicalDevice":false,
            "labelsFrozenBeforeExperiment":["bus":"12 Bern Bahnhof","tram":"8 Brünnen Westside Bhf"],
            "limitations":"DEVELOPMENT photos and controlled composites. Synthetic timing, geometry arrangements and expected contexts are not extra encounters or video identity accuracy. Actual Mac runtime reported independently; no physical latency claim. No expected text enters pipeline. Source photographs and derivatives retain manifest licences, composite CC BY-SA4.0." ]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:out.appendingPathComponent("report.json"))
        print("\(checks-failures.count)/\(checks) multimodal checks passed")
        exit(failures.isEmpty ? 0:1)
    }

    static func draw(_ image:CIImage,_ overlays:[CameraVehicleOverlay],_ context:CIContext,_ url:URL) throws {
        let w = Int(image.extent.width),h = Int(image.extent.height)
        let canvas = CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        canvas.draw(context.createCGImage(image,from:image.extent)!,in:CGRect(x:0,y:0,width:w,height:h))
        for overlay in overlays {
            let positive = overlay.decision.state == .visualCandidate, conflict = overlay.decision.state == .conflicting
            let color = CGColor(red:positive || conflict ? 1:0.5,green:conflict ? 0.1:positive ? 0.65:0.5,blue:positive || conflict ? 0.1:0.5,alpha:0.25)
            canvas.setFillColor(color)
            for r in overlay.maskRuns { canvas.fill(CGRect(x:r.minX*Double(w),y:(1-r.maxY)*Double(h),width:r.width*Double(w),height:r.height*Double(h))) }
            canvas.setStrokeColor(color.copy(alpha:1)!);canvas.setLineWidth(3)
            let b = overlay.box;canvas.stroke(CGRect(x:b.minX*Double(w),y:(1-b.maxY)*Double(h),width:b.width*Double(w),height:b.height*Double(h)))
        }
        let writer = CGImageDestinationCreateWithURL(url as CFURL,"public.png" as CFString,1,nil)!
        CGImageDestinationAddImage(writer,canvas.makeImage()!,nil)
        guard CGImageDestinationFinalize(writer) else { throw VisionPipelineError.unavailable("Cannot save replay image") }
    }
}
