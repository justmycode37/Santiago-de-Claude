import Foundation
import simd

/// Direct, coarse-to-fine photometric alignment. Only observed pixels and a pixel-derived
/// homography enter this optimizer. There is no pose, truth, geographic coordinate or correspondence seed.
enum VisualReferenceRefinement {
    static func matrix(_ p:[Double])->simd_double3x3 {
        .init(columns:(SIMD3(p[0],p[3],p[6]),SIMD3(p[1],p[4],p[7]),SIMD3(p[2],p[5],1)))
    }
    static func solve(_ input:[Double],_ rhs:[Double])->[Double]? {
        let n=rhs.count
        var a=input,b=rhs
        for col in 0..<n {
            var pivot=col
            for row in col..<n where abs(a[row*n+col]) > abs(a[pivot*n+col]) {pivot=row}
            guard abs(a[pivot*n+col]) > 1e-10 else{return nil}
            if pivot != col {for j in 0..<n {a.swapAt(col*n+j,pivot*n+j)};b.swapAt(col,pivot)}
            let d=a[col*n+col]
            for j in col..<n {a[col*n+j] /= d};b[col] /= d
            for row in 0..<n where row != col {
                let f=a[row*n+col]
                for j in col..<n {a[row*n+j] -= f*a[col*n+j]};b[row] -= f*b[col]
            }
        }
        return b.allSatisfy(\.isFinite) ? b : nil
    }
    static func refine(seed:simd_double3x3,reference:VisualReferenceRaster,camera:VisualReferenceRaster)->simd_double3x3? {
        let rscale=simd_double3x3(diagonal:SIMD3(Double(reference.width),Double(reference.height),1))
        let cscale=simd_double3x3(diagonal:SIMD3(Double(camera.width),Double(camera.height),1))
        let normalized=simd_inverse(cscale)*seed*rscale
        guard normalized[2].z.isFinite,abs(normalized[2].z)>1e-9 else{return nil}
        let h=normalized * (1 / normalized[2].z)
        var p=[h[0].x,h[1].x,h[2].x,h[0].y,h[1].y,h[2].y,h[0].z,h[1].z]
        for divisor in [4,2,1] {
            let width=max(64,reference.width/divisor),height=max(64,reference.height/divisor)
            guard let a=VisualReferenceRaster(image:reference.image,width:width,height:height),
                  let b=VisualReferenceRaster(image:camera.image,width:width,height:height) else{return nil}
            for _ in 0..<18 {
                var normal=[Double](repeating:0,count:64),rhs=[Double](repeating:0,count:8)
                var samples=0
                for y in stride(from:3,to:height-3,by:3) {for x in stride(from:3,to:width-3,by:3) {
                    let u=Double(x)/Double(width),v=Double(y)/Double(height)
                    let d=p[6]*u+p[7]*v+1
                    guard d > 0.1 else{continue}
                    let qx=(p[0]*u+p[1]*v+p[2])/d,qy=(p[3]*u+p[4]*v+p[5])/d
                    let q=SIMD2(qx*Double(width),qy*Double(height))
                    guard let value=b.sample(q),let xp=b.sample(q+SIMD2(1,0)),let xm=b.sample(q-SIMD2(1,0)),
                          let yp=b.sample(q+SIMD2(0,1)),let ym=b.sample(q-SIMD2(0,1)) else{continue}
                    let residual=value-Double(a.pixels[y*width+x])/255
                    let gx=(xp-xm)*0.5*Double(width)/d,gy=(yp-ym)*0.5*Double(height)/d
                    if abs(gx)+abs(gy) < 0.03 {continue}
                    let j=[gx*u,gx*v,gx,gy*u,gy*v,gy,-gx*qx*u-gy*qy*u,-gx*qx*v-gy*qy*v]
                    let weight=min(1,0.08/max(1e-9,abs(residual)))
                    for row in 0..<8 {
                        rhs[row] -= weight*j[row]*residual
                        for col in 0..<8 {normal[row*8+col] += weight*j[row]*j[col]}
                    }
                    samples += 1
                } }
                guard samples >= 80 else{return nil}
                for i in 0..<8 {normal[i*8+i] += 1e-4}
                guard let delta=solve(normal,rhs),delta.allSatisfy({abs($0)<0.25}) else{return nil}
                // Small trust region prevents a weak initial hypothesis from jumping across the scene.
                let maximum=delta.map(abs).max() ?? 0
                let step=maximum>0.04 ? 0.04/maximum : 1.0
                for i in 0..<8 {p[i] += step*delta[i]}
                if maximum*step < 1e-6 {break}
            }
        }
        let result=cscale*matrix(p)*simd_inverse(rscale)
        return (0..<3).allSatisfy({c in (0..<3).allSatisfy{result[c][$0].isFinite}}) ? result : nil
    }
}
