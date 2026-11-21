import Foundation
import CoreML
import CoreImage
import ImageIO
import Darwin

/// Real native Core ML/Vision execution on the Mac. Does not simulate an iPhone's ANE, battery, or camera.
@main struct TransportBenchmark {
    static func main() throws {
        guard CommandLine.arguments.count >= 4 else {
            print("usage: benchmark-transport <compiled.mlmodelc> <images-directory> <report.json> [sustained-seconds]")
            exit(2)
        }
        let model = URL(fileURLWithPath: CommandLine.arguments[1])
        let directory = URL(fileURLWithPath: CommandLine.arguments[2])
        let report = URL(fileURLWithPath: CommandLine.arguments[3])
        let context = CIContext(options: [.cacheIntermediates: false])
        let detector = try TransportSegmenter(url: model)
        let pipeline = LocalVehiclePipeline(modelURL: model)
        if CommandLine.arguments.contains("--fast-ocr") { pipeline.displayRecognitionLevel = .fast }
        pipeline.trace = { print($0) }
        let epoch = UUID()
        var rows: [[String: Any]] = []
        var durations: [Double] = []
        var samples: [(String, CIImage)] = []
        for name in ["bus", "tram", "train", "tram-holdout"] {
            guard let original = CIImage(contentsOf: directory.appendingPathComponent(name + ".jpg")) else { continue }
            let scale = min(1, 1280 / max(original.extent.width, original.extent.height))
            let image = original.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            samples.append((name, image))
            for variant in ["original", "blur", "dark", "occluded"] {
                let modified: CIImage
                switch variant {
                case "blur": modified = image.applyingFilter("CIMotionBlur", parameters: ["inputRadius": 18, "inputAngle": 0]).cropped(to: image.extent)
                case "dark": modified = image.applyingFilter("CIExposureAdjust", parameters: ["inputEV": -3])
                case "occluded":
                    let rect = CGRect(x: image.extent.width * 0.4, y: 0, width: image.extent.width * 0.25, height: image.extent.height)
                    modified = CIImage(color: .black).cropped(to: rect).composited(over: image)
                default: modified = image
                }
                let start = ProcessInfo.processInfo.systemUptime
                let detections = try detector.detect(modified)
                let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000
                if variant == "original" { try overlay(image: modified, detections: detections, context: context, url: report.deletingLastPathComponent().appendingPathComponent(name + "-mask.png")) }
                let buffer = try pixelBuffer(modified, context: context)
                let result = try pipeline.process(buffer: buffer, orientation: .up, at: Date(), epoch: UUID())
                rows.append(["image": name, "variant": variant, "detectorMS": elapsed, "pipelineMS": result.latencyMS,
                    "detections": detections.map { d -> [String: Any] in
                        ["class": d.kind.rawValue, "rawModelScore": d.score,
                         "box": [d.box.minX,d.box.minY,d.box.width,d.box.height],
                         "maskPixels": d.mask.pixels.filter { $0 != 0 }.count]
                    }, "ocr": result.tracks.map { ["class": $0.detection.kind.rawValue, "text": $0.readings.last?.raw ?? []] }])
                print("\(name) \(variant): \(detections.map { $0.kind.rawValue }) detector \(Int(elapsed))ms pipeline \(Int(result.latencyMS))ms")
            }
        }
        let seconds = CommandLine.arguments.count > 4 ? Double(CommandLine.arguments[4]) ?? 0 : 0
        pipeline.trace = nil
        let started = ProcessInfo.processInfo.systemUptime
        var frame = 0
        // Bounded synchronous work, one buffer in flight, nominal 2.5Hz scheduling as in the app.
        while ProcessInfo.processInfo.systemUptime - started < seconds, !samples.isEmpty {
            try autoreleasepool {
                let begin = ProcessInfo.processInfo.systemUptime
                let image = samples[frame % samples.count].1
                let buffer = try pixelBuffer(image, context: context)
                let result = try pipeline.process(buffer: buffer, orientation: .up, at: Date(), epoch: epoch)
                durations.append(result.latencyMS)
                frame += 1
                let remaining = 0.4 - (ProcessInfo.processInfo.systemUptime - begin)
                if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
            }
        }
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        let sorted = durations.sorted()
        var hardwareSize = 0
        sysctlbyname("machdep.cpu.brand_string", nil, &hardwareSize, nil, 0)
        var hardware = [CChar](repeating: 0, count: max(1,hardwareSize))
        sysctlbyname("machdep.cpu.brand_string", &hardware, &hardwareSize, nil, 0)
        let summary: [String: Any] = ["hardware": String(cString: hardware), "physicalMemoryBytes": ProcessInfo.processInfo.physicalMemory,
            "platform": ProcessInfo.processInfo.operatingSystemVersionString,
            "notIPhoneBenchmark": true, "coreMLComputeUnits": "all (placement decided by Core ML)", "samples": rows,
            "sustainedSeconds": ProcessInfo.processInfo.systemUptime - started, "sustainedFrames": frame,
            "pipelineP50MS": sorted.isEmpty ? 0 : sorted[sorted.count/2],
            "pipelineP95MS": sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))],
            "maxResidentBytes": usage.ru_maxrss,
            "thermalStateAtEnd": ProcessInfo.processInfo.thermalState.rawValue,
            "limitations": "Four photographs (one held out during prompt selection) plus synthetic degradations, no annotated mask ground truth or recall estimate. Memory includes two model instances in this benchmark; the app uses one. Camera capture, ARKit and battery are not exercised."]
        try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]).write(to: report)
        print("Report: \(report.path)")
    }
    static func overlay(image: CIImage, detections: [VehicleDetection], context: CIContext, url: URL) throws {
        let width = Int(image.extent.width), height = Int(image.extent.height)
        guard let source = context.createCGImage(image, from: image.extent),
              let canvas = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                     space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        canvas.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        for d in detections {
            canvas.setFillColor(CGColor(red: 0, green: 0.9, blue: 0.7, alpha: 0.35))
            for run in d.mask.runs {
                canvas.fill(CGRect(x: run.minX * Double(width), y: (1-run.maxY) * Double(height), width: run.width * Double(width), height: run.height * Double(height)))
            }
            canvas.setStrokeColor(CGColor(red: 1, green: 0.7, blue: 0, alpha: 1)); canvas.setLineWidth(3)
            canvas.stroke(CGRect(x: d.box.minX * Double(width), y: (1-d.box.maxY) * Double(height), width: d.box.width * Double(width), height: d.box.height * Double(height)))
        }
        guard let output = canvas.makeImage(), let writer = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(writer, output, nil); CGImageDestinationFinalize(writer)
    }
    static func pixelBuffer(_ image: CIImage, context: CIContext) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, Int(image.extent.width), Int(image.extent.height), kCVPixelFormatType_32BGRA,
                                  [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer) == kCVReturnSuccess, let buffer else {
            throw VisionPipelineError.unavailable("Benchmark allocation failed")
        }
        context.render(image, to: buffer, bounds: image.extent, colorSpace: CGColorSpaceCreateDeviceRGB())
        return buffer
    }
}
