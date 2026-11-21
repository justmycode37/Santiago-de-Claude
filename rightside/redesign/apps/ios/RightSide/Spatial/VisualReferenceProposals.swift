import Foundation
import Vision
import simd

/// Rectangles supply measured corner hypotheses, never semantic identity or a phone coordinate.
/// Reference appearance must validate every proposal; repeated copies at different locations abstain.
enum VisualReferenceProposals {
    static func homography(corners:[SIMD2<Double>],width:Int,height:Int)->simd_double3x3? {
        guard corners.count == 4 else{return nil}
        let source=[SIMD2(0.0,0.0),SIMD2(1,0),SIMD2(1,1),SIMD2(0,1)]
        var a=[Double](),b=[Double]()
        for i in 0..<4 {
            let x=source[i].x,y=source[i].y,u=corners[i].x/Double(width),v=corners[i].y/Double(height)
            a.append(contentsOf:[x,y,1,0,0,0,-u*x,-u*y]);b.append(u)
            a.append(contentsOf:[0,0,0,x,y,1,-v*x,-v*y]);b.append(v)
        }
        guard let p=VisualReferenceRefinement.solve(a,b) else{return nil}
        let scale=simd_double3x3(diagonal:SIMD3(Double(width),Double(height),1))
        return scale*VisualReferenceRefinement.matrix(p)*simd_inverse(scale)
    }
    static func rectangles(camera:VisualReferenceRaster)throws->[simd_double3x3] {
        let request=VNDetectRectanglesRequest()
        request.revision=VNDetectRectanglesRequestRevision1
        request.maximumObservations=4;request.minimumConfidence=0.7;request.minimumSize=0.15
        request.minimumAspectRatio=0.4;request.maximumAspectRatio=1;request.quadratureTolerance=30
        try VNImageRequestHandler(cgImage:camera.image,orientation:.up,options:[:]).perform([request])
        return (request.results ?? []).compactMap { observation in
            let corners=[observation.topLeft,observation.topRight,observation.bottomRight,observation.bottomLeft].map {
                SIMD2(Double($0.x)*Double(camera.width),(1-Double($0.y))*Double(camera.height))
            }
            return homography(corners:corners,width:camera.width,height:camera.height)
        }
    }
}
