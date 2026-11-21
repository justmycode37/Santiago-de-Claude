import Foundation
import simd

struct VisualReferenceFeatureProposal {
    let homography:simd_double3x3
    let referenceFeatureCount:Int
    let cameraFeatureCount:Int
    let mutualMatchCount:Int
    let inlierCount:Int
    let medianSymmetricErrorPixels:Double
}

/// Bounded classical pixel feature proposal. Independently implemented Harris + oriented
/// gradient histograms, mutual ratio matching and robust homography. No learned model,
/// reference pose, evaluation homography or geographic data enters matching.
/// Inspired by Lowe's local gradient descriptor/ratio test, not a claim of exact SIFT parity.
enum VisualReferenceFeatures {
    static let configurationID="harris3levels-root128-mutual075-ransac768-v1"
    private struct Feature {let point:SIMD2<Double>;let descriptor:[SIMD8<Float>]}
    private struct Pair {let a:SIMD2<Double>;let b:SIMD2<Double>;let distance:Float}
    private static func blurred(_ raster:VisualReferenceRaster)->[Float] {
        let w=raster.width,h=raster.height
        var horizontal=[Float](repeating:0,count:w*h),result=horizontal
        for y in 0..<h {for x in 0..<w {
            horizontal[y*w+x]=(Float(raster.pixels[y*w+max(0,x-1)])+2*Float(raster.pixels[y*w+x])+Float(raster.pixels[y*w+min(w-1,x+1)]))/1020
        } }
        for y in 0..<h {for x in 0..<w {
            result[y*w+x]=(horizontal[max(0,y-1)*w+x]+2*horizontal[y*w+x]+horizontal[min(h-1,y+1)*w+x])/4
        } }
        return result
    }
    private static func extract(_ image:VisualReferenceRaster)->[Feature] {
        var features=[Feature]()
        for scale in [1.0,0.75,0.5] {
            let w=Int(Double(image.width)*scale),h=Int(Double(image.height)*scale)
            guard w>=64,h>=64,let raster=VisualReferenceRaster(image:image.image,width:w,height:h) else {continue}
            let pixels=blurred(raster)
            var gx=[Float](repeating:0,count:w*h),gy=gx
            for y in 1..<h-1 {for x in 1..<w-1 {
                gx[y*w+x]=(pixels[y*w+x+1]-pixels[y*w+x-1])/2
                gy[y*w+x]=(pixels[(y+1)*w+x]-pixels[(y-1)*w+x])/2
            } }
            let stride_=w+1
            var xx=[Double](repeating:0,count:(w+1)*(h+1)),yy=xx,xy=xx
            for y in 0..<h {
                var sx=0.0,sy=0.0,sz=0.0
                for x in 0..<w {
                    let a=Double(gx[y*w+x]),b=Double(gy[y*w+x]);sx+=a*a;sy+=b*b;sz+=a*b
                    let index=(y+1)*stride_+x+1
                    xx[index]=xx[index-stride_]+sx;yy[index]=yy[index-stride_]+sy;xy[index]=xy[index-stride_]+sz
                }
            }
            func sum(_ values:[Double],_ x:Int,_ y:Int)->Double {
                let x0=x-2,x1=x+3,y0=y-2,y1=y+3
                return values[y1*stride_+x1]-values[y0*stride_+x1]-values[y1*stride_+x0]+values[y0*stride_+x0]
            }
            var response=[Double](repeating:0,count:w*h),maximum=0.0
            for y in 24..<h-24 {for x in 24..<w-24 {
                let a=sum(xx,x,y),b=sum(yy,x,y),c=sum(xy,x,y)
                let value=a*b-c*c-0.04*(a+b)*(a+b)
                response[y*w+x]=value;maximum=max(maximum,value)
            } }
            guard maximum>1e-8 else {continue}
            var corners=[(Int,Int,Double)]()
            for y in 24..<h-24 {for x in 24..<w-24 {
                let value=response[y*w+x]
                guard value>maximum*0.005 else {continue}
                var peak=true
                for dy in -2...2 {for dx in -2...2 where dx != 0 || dy != 0 {
                    if response[(y+dy)*w+x+dx]>=value {peak=false}
                } }
                if peak {corners.append((x,y,value))}
            } }
            corners.sort{$0.2>$1.2}
            var selected=[SIMD2<Int>]()
            for (x,y,_) in corners {
                if selected.count>=160 {break}
                guard !selected.contains(where:{let dx=$0.x-x,dy=$0.y-y;return dx*dx+dy*dy<64}) else {continue}
                var orientation=[Float](repeating:0,count:36)
                for dy in -8...8 {for dx in -8...8 {
                    let index=(y+dy)*w+x+dx,a=gx[index],b=gy[index]
                    let angle=atan2(b,a)+Float.pi
                    let bin=min(35,Int(angle*36/(2*Float.pi)))
                    orientation[bin]+=sqrt(a*a+b*b)*exp(-Float(dx*dx+dy*dy)/64)
                } }
                guard let peak=orientation.indices.max(by:{orientation[$0]<orientation[$1]}),orientation[peak]>0.01 else {continue}
                let angle=(Double(peak)+0.5)*2 * .pi/36 - .pi
                let cosine=cos(angle),sine=sin(angle)
                var histogram=[Float](repeating:0,count:128)
                for dy in -16..<16 {for dx in -16..<16 {
                    let rx=Double(x)+cosine*Double(dx)-sine*Double(dy)
                    let ry=Double(y)+sine*Double(dx)+cosine*Double(dy)
                    let ix=Int(rx.rounded()),iy=Int(ry.rounded())
                    guard ix>0,ix<w-1,iy>0,iy<h-1 else {continue}
                    let a=gx[iy*w+ix],b=gy[iy*w+ix]
                    var direction=Double(atan2(b,a))-angle
                    direction.formTruncatingRemainder(dividingBy:2 * .pi);if direction<0 {direction+=2 * .pi}
                    let ob=direction*8/(2 * .pi),base=Int(ob)%8,fraction=Float(ob-Double(Int(ob)))
                    let cellX=(dx+16)/8,cellY=(dy+16)/8,index=(cellY*4+cellX)*8
                    let magnitude=sqrt(a*a+b*b)*exp(-Float(dx*dx+dy*dy)/256)
                    histogram[index+base]+=magnitude*(1-fraction);histogram[index+(base+1)%8]+=magnitude*fraction
                } }
                let norm=sqrt(histogram.reduce(0){$0+$1*$1})
                guard norm>0.01 else {continue}
                for i in histogram.indices {histogram[i]=min(0.2,histogram[i]/norm)}
                let l1=histogram.reduce(0,+)
                var descriptor=[SIMD8<Float>]()
                for index in stride(from:0,to:128,by:8) {descriptor.append(SIMD8((index..<index+8).map{sqrt(histogram[$0]/l1)}))}
                selected.append(SIMD2(x,y));features.append(.init(point:SIMD2(Double(x)/scale,Double(y)/scale),descriptor:descriptor))
            }
        }
        return features
    }
    private static func pairs(_ reference:[Feature],_ camera:[Feature])->[Pair] {
        guard reference.count>=12,camera.count>=12 else{return []}
        var best=[Int](repeating:-1,count:reference.count),bestD=[Float](repeating:.infinity,count:reference.count),secondD=bestD
        var reverse=[Int](repeating:-1,count:camera.count),reverseD=[Float](repeating:.infinity,count:camera.count),reverseSecond=reverseD
        for i in reference.indices {for j in camera.indices {
            var distance:Float=0
            for k in 0..<16 {let delta=reference[i].descriptor[k]-camera[j].descriptor[k];distance+=simd_reduce_add(delta*delta)}
            if distance<bestD[i] {secondD[i]=bestD[i];bestD[i]=distance;best[i]=j}else if distance<secondD[i] {secondD[i]=distance}
            if distance<reverseD[j] {reverseSecond[j]=reverseD[j];reverseD[j]=distance;reverse[j]=i}else if distance<reverseSecond[j] {reverseSecond[j]=distance}
        } }
        var candidates=[Pair]()
        for i in reference.indices {
            let j=best[i]
            if j>=0,reverse[j]==i,bestD[i]<0.5625*secondD[i],reverseD[j]<0.5625*reverseSecond[j],bestD[i]<0.8 {
                candidates.append(.init(a:reference[i].point,b:camera[j].point,distance:bestD[i]))
            }
        }
        candidates.sort{$0.distance<$1.distance}
        var unique=[Pair]()
        for pair in candidates {
            if !unique.contains(where:{simd_distance($0.a,pair.a)<5 || simd_distance($0.b,pair.b)<5}) {unique.append(pair)}
        }
        return unique
    }
    private static func fit(_ pairs:[Pair],width:Int,height:Int)->simd_double3x3? {
        var normal=[Double](repeating:0,count:64),rhs=[Double](repeating:0,count:8)
        for pair in pairs {
            let x=pair.a.x/Double(width),y=pair.a.y/Double(height),u=pair.b.x/Double(width),v=pair.b.y/Double(height)
            let rows=[[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]
            for (row,value) in zip(rows,[u,v]) {for i in 0..<8 {rhs[i]+=row[i]*value;for j in 0..<8 {normal[i*8+j]+=row[i]*row[j]}}}
        }
        guard let solution=VisualReferenceRefinement.solve(normal,rhs) else{return nil}
        let scale=simd_double3x3(diagonal:SIMD3(Double(width),Double(height),1))
        return scale*VisualReferenceRefinement.matrix(solution)*simd_inverse(scale)
    }
    private static func error(_ h:simd_double3x3,_ inverse:simd_double3x3,_ pair:Pair)->Double {
        guard let forward=VisualReferenceGeometry.point(h,pair.a),let back=VisualReferenceGeometry.point(inverse,pair.b) else{return .infinity}
        return max(simd_distance(forward,pair.b),simd_distance(back,pair.a))
    }
    static func propose(reference:VisualReferenceRaster,camera:VisualReferenceRaster)->VisualReferenceFeatureProposal? {
        guard reference.width==camera.width,reference.height==camera.height,VisualReferenceMatcher.hasDistinctTexture(reference) else{return nil}
        let a=extract(reference),b=extract(camera),matches=pairs(a,b)
        guard matches.count>=12 else{return nil}
        var state:UInt64=0x6297c25,models=[(simd_double3x3,[Int])]()
        for _ in 0..<768 {
            var indices=Set<Int>()
            while indices.count<4 {state=state &* 6364136223846793005 &+ 1442695040888963407;indices.insert(Int((state>>32)%UInt64(matches.count)))}
            guard let h=fit(indices.sorted().map{matches[$0]},width:reference.width,height:reference.height),abs(simd_determinant(h))>1e-9 else{continue}
            let inverse=simd_inverse(h)
            let inliers=matches.indices.filter{error(h,inverse,matches[$0])<=3}
            if inliers.count>=12 {models.append((h,inliers))}
        }
        guard let best=models.max(by:{$0.1.count<$1.1.count}),Double(best.1.count)/Double(matches.count)>=0.3,
              let h=fit(best.1.map{matches[$0]},width:reference.width,height:reference.height) else{return nil}
        let inverse=simd_inverse(h),inliers=matches.indices.filter{error(h,inverse,matches[$0])<=3}
        guard inliers.count>=12 else{return nil}
        var cells=Set<Int>()
        for i in inliers {let p=matches[i].a;cells.insert(min(3,Int(p.x/Double(reference.width)*4))+4*min(3,Int(p.y/Double(reference.height)*4)))}
        guard cells.count>=6 else{return nil}
        // A second convincing, spatially different mapping is ambiguity, not a lower-ranked answer.
        let probes=[SIMD2(0.0,0),SIMD2(Double(reference.width),Double(reference.height)),SIMD2(Double(reference.width)/2,Double(reference.height)/2)]
        for (alternative,support) in models where support.count>=max(12,Int(Double(inliers.count)*0.8)) {
            let disagreement=probes.compactMap {p->Double? in
                guard let x=VisualReferenceGeometry.point(h,p),let y=VisualReferenceGeometry.point(alternative,p) else{return nil};return simd_distance(x,y)
            }
            if disagreement.count==3,disagreement.allSatisfy({$0>12}) {return nil}
        }
        let errors=inliers.map{error(h,inverse,matches[$0])}.sorted()
        return .init(homography:h,referenceFeatureCount:a.count,cameraFeatureCount:b.count,mutualMatchCount:matches.count,
                     inlierCount:inliers.count,medianSymmetricErrorPixels:errors[errors.count/2])
    }
}
