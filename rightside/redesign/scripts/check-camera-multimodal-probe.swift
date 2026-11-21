import Foundation
import CoreImage
import Vision

/// Development-only diagnostic. No expectation argument or route vocabulary is accepted.
/// All crops originate from the actual model box and observed OCR glyph geometry.
@main struct MultimodalProbe {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { exit(2) }
        let imageURL = URL(fileURLWithPath: args[2]), output = URL(fileURLWithPath: args[3])
        let original = CIImage(contentsOf: imageURL)!
        let detector = try TransportSegmenter(url: URL(fileURLWithPath: args[1]))
        let context = CIContext(options: [.cacheIntermediates: false])
        let scale = min(1, 2560 / max(original.extent.width, original.extent.height))
        let image = original.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        var report: [[String: Any]] = []
        func recognize(_ input: CIImage, region: CGRect, horizontalScale: Double, contrast: Double, name: String,
                       fast: Bool = false, invert: Bool = false, correction: Bool = false, maxEdge: Double = 1600) throws -> [VehicleText] {
            let pixels = CGRect(x: region.minX * input.extent.width, y: (1-region.maxY) * input.extent.height,
                width: region.width * input.extent.width, height: region.height * input.extent.height).integral.intersection(input.extent)
            guard !pixels.isEmpty else { return [] }
            let bound = min(2, maxEdge / (pixels.width * horizontalScale))
            let transformed = input.cropped(to: pixels).transformed(by: CGAffineTransform(scaleX: bound * horizontalScale, y: bound))
            var prepared = contrast == 1 ? transformed : transformed.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0, kCIInputContrastKey: contrast])
            if invert { prepared = prepared.applyingFilter("CIColorInvert") }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = fast ? .fast : .accurate; request.usesLanguageCorrection = correction
            request.recognitionLanguages = ["de-DE", "fr-FR", "en-US"]; request.minimumTextHeight = 0.025
            let started = ProcessInfo.processInfo.systemUptime
            try VNImageRequestHandler(cgImage: context.createCGImage(prepared, from: prepared.extent)!).perform([request])
            let texts = (request.results ?? []).compactMap { item -> VehicleText? in
                guard let candidate = item.topCandidates(1).first else { return nil }
                let r = item.boundingBox
                return VehicleText(text: candidate.string, box: CGRect(x: (pixels.minX+r.minX*pixels.width)/input.extent.width,
                    y: 1-(pixels.minY+r.maxY*pixels.height)/input.extent.height, width: r.width*pixels.width/input.extent.width,
                    height: r.height*pixels.height/input.extent.height), score: candidate.confidence)
            }
            let row: [String: Any] = ["name": name, "horizontalScale": horizontalScale, "contrast": contrast,
                "milliseconds": (ProcessInfo.processInfo.systemUptime-started)*1000,
                "region": [region.minX,region.minY,region.width,region.height],
                "texts": texts.map { ["text": $0.text, "confidence": $0.score, "box": [$0.box.minX,$0.box.minY,$0.box.width,$0.box.height]] as [String:Any] }]
            report.append(row)
            print(name, texts.map { "\($0.text) [\($0.score)]" }); fflush(stdout)
            return texts
        }
        for (index, detection) in try detector.detect(image).enumerated() {
            let b = detection.box
            let body = try recognize(image, region: b, horizontalScale: 1, contrast: 1, name: "\(index)-body")
            let upper = CGRect(x: b.minX, y: b.minY, width: b.width, height: b.height*0.55)
            let upperTexts = try recognize(image, region: upper, horizontalScale: 1, contrast: 1, name: "\(index)-upper")
            let anchors = (body + upperTexts).filter { $0.score >= 0.7 && $0.box.midY < b.minY+b.height*0.65
                && $0.text.range(of: #"^[A-Za-z]{0,2}\s?\d{1,3}$"#, options: .regularExpression) != nil }
            for (rowIndex, anchor) in anchors.prefix(2).enumerated() {
                let h = anchor.box.height
                let region = CGRect(x: anchor.box.minX-h*0.3, y: anchor.box.minY-h*0.5,
                    width: anchor.box.width+h*12.6, height: h*2).intersection(upper)
                for stretch in [1.0,1.5,2.0] {
                    for contrast in [1.0,1.4] {
                        _ = try recognize(image, region: region, horizontalScale: stretch, contrast: contrast,
                            name: "\(index)-observed-row\(rowIndex)-stretch\(stretch)-contrast\(contrast)")
                    }
                }
                // Second hypothesis: glyph-oriented OCR and LED polarity/sampling. These are
                // fixed pixel transforms, not selected-route dictionaries or answer injection.
                for fast in [true,false] {
                    for invert in [false,true] {
                        for edge in [512.0,1024.0] {
                            _ = try recognize(image, region: region, horizontalScale: 1, contrast: 1,
                                name: "\(index)-row\(rowIndex)-fast\(fast)-invert\(invert)-edge\(edge)",
                                fast: fast, invert: invert, maxEdge: edge)
                        }
                    }
                }
                _ = try recognize(image, region: region, horizontalScale: 1, contrast: 1,
                    name: "\(index)-row\(rowIndex)-generic-language-correction", correction: true)
            }
        }
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys]).write(to: output)
    }
}
