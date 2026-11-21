import Foundation
import Vision
import CoreGraphics
import simd

/// Immutable decoded pixels. The CGImage and byte array are never mutated after creation.
struct VisualReferenceRaster: @unchecked Sendable {
    let image: CGImage
    let width: Int
    let height: Int
    let pixels: [UInt8]
    init?(image: CGImage, width: Int, height: Int) {
        guard (64...1024).contains(width), (64...1024).contains(height) else { return nil }
        var bytes = [UInt8](repeating: 0, count: width * height)
        let rendered: CGImage? = bytes.withUnsafeMutableBytes { buffer in
            guard let c = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
            c.interpolationQuality = .high
            c.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return c.makeImage()
        }
        guard let rendered else { return nil }
        self.image = rendered; self.width = width; self.height = height; pixels = bytes
    }
    func sample(_ p: SIMD2<Double>) -> Double? {
        guard p.x >= 0, p.y >= 0, p.x < Double(width - 1), p.y < Double(height - 1) else { return nil }
        let x = Int(p.x), y = Int(p.y), dx = p.x - Double(x), dy = p.y - Double(y)
        return ((1-dx)*(1-dy)*Double(pixels[y*width+x]) + dx*(1-dy)*Double(pixels[y*width+x+1])
            + (1-dx)*dy*Double(pixels[(y+1)*width+x]) + dx*dy*Double(pixels[(y+1)*width+x+1])) / 255
    }
}
struct VisualReferenceMatch {
    let id: String
    let pose: VisualReferencePose
    let correlation: Double
    let validFraction: Double
    let alignedPatchFraction: Double
}
struct VisualReferenceRegistration {
    let homography: simd_double3x3
    let correlation: Double
    let validFraction: Double
    let alignedPatchFraction: Double
}

enum VisualReferenceMatcher {
    // Version includes normalization, Vision revision and every acceptance threshold. Validation
    // contracts bind this exact identifier; changing thresholds requires a new identifier.
    static let configurationID = "vision-rect4-harris-r1-photometric640-gravity-v3"
    static let maximumDimension = 640
    static func correlation(_ a: [Double], _ b: [Double]) -> Double {
        guard a.count == b.count, a.count >= 16 else { return -1 }
        let count = Double(a.count), ma = a.reduce(0,+)/count, mb = b.reduce(0,+)/count
        var aa=0.0, bb=0.0, ab=0.0
        for i in a.indices { let x=a[i]-ma,y=b[i]-mb; aa+=x*x;bb+=y*y;ab+=x*y }
        guard aa/count > 0.0025, bb/count > 0.0025 else { return -1 }
        return ab / sqrt(aa*bb)
    }
    /// Reject obvious repeated/flat references before inference. This finite autocorrelation
    /// screen is not proof of site uniqueness; reviewed distinct references remain mandatory.
    static func hasDistinctTexture(_ r: VisualReferenceRaster) -> Bool {
        var a=[Double](), b=[Double]()
        for sy in [0, r.height/8, r.height/4, r.height/2] {
            for sx in [0, r.width/8, r.width/4, r.width/2] where sx != 0 || sy != 0 {
                a.removeAll(keepingCapacity:true); b.removeAll(keepingCapacity:true)
                for y in stride(from:0,to:r.height-sy,by:7) { for x in stride(from:0,to:r.width-sx,by:7) {
                    a.append(Double(r.pixels[y*r.width+x])/255)
                    b.append(Double(r.pixels[(y+sy)*r.width+x+sx])/255)
                } }
                if correlation(a,b) > 0.92 { return false }
            }
        }
        return true
    }
    /// Registration is a bounded local-alignment hypothesis, not global image retrieval.
    /// Apple's target is the floating reference image; handler is the captured camera image.
    /// Vision returns pixels in Core Image bottom-left coordinates; canonical geometry uses top-left.
    static func register(reference: VisualReferenceRaster, camera: VisualReferenceRaster,
                         proposals: [simd_double3x3]? = nil) throws -> VisualReferenceRegistration? {
        guard reference.width == camera.width, reference.height == camera.height,
              hasDistinctTexture(reference) else { return nil }
        var seeds = proposals ?? ((try? VisualReferenceProposals.rectangles(camera: camera)) ?? [])
        if let h = try? rawHomography(reference: reference, camera: camera) {
            let flip = simd_double3x3(columns:(SIMD3(1,0,0),SIMD3(0,-1,0),SIMD3(0,Double(camera.height),1)))
            seeds.insert(flip * h * flip, at: 0)
        }
        var accepted = [VisualReferenceRegistration]()
        for seed in seeds.prefix(5) {
            guard let refined = VisualReferenceRefinement.refine(seed: seed, reference: reference, camera: camera),
                  let result = validate(h: refined, reference: reference, camera: camera) else { continue }
            accepted.append(result)
        }
        if accepted.isEmpty,let proposal=VisualReferenceFeatures.propose(reference:reference,camera:camera),
           let refined=VisualReferenceRefinement.refine(seed:proposal.homography,reference:reference,camera:camera),
           let result=validate(h:refined,reference:reference,camera:camera) {
            accepted.append(result)
        }
        guard let best = accepted.max(by: {$0.correlation < $1.correlation}) else { return nil }
        // Multiple convincing appearances of the same reference cannot establish unique identity.
        for alternative in accepted {
            for p in [SIMD2(0.0,0.0),SIMD2(Double(reference.width),Double(reference.height)),
                      SIMD2(Double(reference.width)/2,Double(reference.height)/2)] {
                guard let a = VisualReferenceGeometry.point(best.homography,p),
                      let b = VisualReferenceGeometry.point(alternative.homography,p),simd_distance(a,b) < 4 else { return nil }
            }
        }
        return best
    }
    static func rawHomography(reference: VisualReferenceRaster, camera: VisualReferenceRaster) throws -> simd_double3x3? {
        let request = VNHomographicImageRegistrationRequest(targetedCGImage: reference.image, options: [:])
        request.revision = VNHomographicImageRegistrationRequestRevision1
        let handler = VNImageRequestHandler(cgImage: camera.image, orientation: .up, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.first else { return nil }
        let v = observation.warpTransform
        return simd_double3x3(columns: (SIMD3<Double>(v[0]), SIMD3<Double>(v[1]), SIMD3<Double>(v[2])))
    }
    static func validate(h: simd_double3x3, reference: VisualReferenceRaster,
                         camera: VisualReferenceRaster) -> VisualReferenceRegistration? {
        guard (0..<3).allSatisfy({ c in (0..<3).allSatisfy { h[c][$0].isFinite } }),
              abs(simd_determinant(h)) > 1e-8 else { return nil }
        var allA=[Double](), allB=[Double](), valid=0, attempted=0, goodPatches=0, texturedPatches=0
        // 8x8 spatial cells, disjoint samples: require evidence across the reference, not one sign corner.
        for cellY in 0..<8 { for cellX in 0..<8 {
            var a=[Double](), b=[Double]()
            for dy in 0..<5 { for dx in 0..<5 {
                let p=SIMD2((Double(cellX)+(Double(dx)+0.5)/5)*Double(reference.width)/8,
                            (Double(cellY)+(Double(dy)+0.5)/5)*Double(reference.height)/8)
                attempted += 1
                guard let q=VisualReferenceGeometry.point(h,p), let av=reference.sample(p), let bv=camera.sample(q) else { continue }
                a.append(av); b.append(bv); valid += 1
            } }
            let ncc=correlation(a,b)
            if a.count >= 20 { texturedPatches += 1; if ncc >= 0.75 { goodPatches += 1 } }
            allA.append(contentsOf:a);allB.append(contentsOf:b)
        } }
        let fraction=Double(valid)/Double(attempted), aligned=Double(goodPatches)/64
        let ncc=correlation(allA,allB)
        guard fraction >= 0.75, texturedPatches >= 48, aligned >= 0.65, ncc >= 0.80 else { return nil }
        let corners=[SIMD2(0.0,0.0),SIMD2(Double(reference.width),0),
                     SIMD2(Double(reference.width),Double(reference.height)),SIMD2(0,Double(reference.height))]
        let q=corners.compactMap { VisualReferenceGeometry.point(h,$0) }
        guard q.count == 4 else { return nil }
        var cross=[Double]()
        for i in 0..<4 { let a=q[(i+1)%4]-q[i],b=q[(i+2)%4]-q[(i+1)%4];cross.append(a.x*b.y-a.y*b.x) }
        guard cross.allSatisfy({$0 > 0}), cross.min()! > Double(camera.width*camera.height)*0.08 else { return nil }
        return .init(homography:h,correlation:ncc,validFraction:fraction,alignedPatchFraction:aligned)
    }
    static func match(reference: VisualReferenceRaster, camera: VisualReferenceRaster,
                      originalCalibration k: SpatialCameraCalibration, plane: VisualReferencePlane,
                      proposals: [simd_double3x3]? = nil) throws -> VisualReferenceMatch? {
        guard k.isValid else { return nil }
        let sx=Double(camera.width)/Double(k.width), sy=Double(camera.height)/Double(k.height)
        let scaled=SpatialCameraCalibration(width:camera.width,height:camera.height,fx:k.fx*sx,fy:k.fy*sy,
            cx:k.cx*sx,cy:k.cy*sy,imageOrientation:k.imageOrientation)
        guard let registered=try register(reference:reference,camera:camera,proposals:proposals),
              let pose=VisualReferenceGeometry.pose(h:registered.homography,referenceWidth:reference.width,
                referenceHeight:reference.height,calibration:scaled,plane:plane) else { return nil }
        return .init(id:plane.id,pose:pose,correlation:registered.correlation,validFraction:registered.validFraction,
                     alignedPatchFraction:registered.alignedPatchFraction)
    }
}
