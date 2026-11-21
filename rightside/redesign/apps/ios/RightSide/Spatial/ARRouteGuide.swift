import Foundation
import ARKit
import SceneKit
import CoreLocation
import UIKit

/// Places the walking route and the boarding point in the live, world-tracked camera without Apple's
/// geographic AR service. Alignment comes from GeoARAlignment (compass + GPS + walked path) and every
/// drawing decision from ARRouteGuidance, so poor alignment hides the arrows instead of drawing them wrong.
/// Owned by LiveCameraController on the main actor; its nodes live under one root node.
@MainActor final class ARRouteGuide {
    private(set) var plan: ARRouteGuidance.Plan?
    let root = SCNNode()
    private var alignment = GeoARAlignment()
    private var plane: LocalTangentPlane?
    private var lastFix: Date?
    private var lastHeading: Date?
    private var lastUpdate: TimeInterval = 0
    private var contextKey = ""
    private var markerNodes: [SCNNode] = []
    private var targetNode: SCNNode?
    /// Typical height of a hand-held phone above the pavement; the ground arrows are drawn this far below the camera.
    static let phoneHeight: Float = 1.4

    /// True heading of the camera's optical axis from the fused alignment (compass + GPS + walked path),
    /// with its one-sigma error in degrees; nil before an alignment exists.
    func cameraTrueHeading(frame: ARFrame) -> (degrees: Double, sigma: Double)? {
        guard let solution = alignment.solution(at: Date()) else { return nil }
        let t = frame.camera.transform
        let forward = Vec2(x: Double(-t.columns.2.x), y: Double(t.columns.2.z))
        guard forward.length > 0.3 else { return nil }
        let east = forward.angle - solution.yaw
        let degrees = (90 - east * 180 / .pi).truncatingRemainder(dividingBy: 360)
        return (degrees < 0 ? degrees + 360 : degrees, max(5, solution.yawSigmaDegrees))
    }

    func reset() {
        alignment.reset(); plane = nil; lastFix = nil; lastHeading = nil; plan = nil; lastUpdate = 0
        clearNodes()
    }

    /// Called for every AR frame while the journey camera runs in world tracking. Work is throttled to 5 Hz.
    func update(frame: ARFrame, location: LocationController?, route: [CLLocationCoordinate2D],
                target: CLLocationCoordinate2D?, targetLabel: String, contextID: String) {
        if contextID != contextKey { contextKey = contextID; reset() }
        guard frame.timestamp - lastUpdate >= 0.2 else { return }
        lastUpdate = frame.timestamp
        guard case .normal = frame.camera.trackingState else { clearNodes(); plan = nil; return }
        let transform = frame.camera.transform
        let position = transform.columns.3
        let camera = Vec2(x: Double(position.x), y: Double(-position.z))
        // The camera looks along −Z of its transform; project that onto the horizontal AR plane (x, −z).
        let forward = Vec2(x: Double(-transform.columns.2.x), y: Double(transform.columns.2.z))
        let direction = forward.length > 0.3 ? forward.angle : nil
        let now = Date()

        if let heading = location?.heading, let direction, heading.headingAccuracy >= 0,
           now.timeIntervalSince(heading.timestamp) < 1, heading.timestamp != lastHeading {
            lastHeading = heading.timestamp
            alignment.add(.init(at: heading.timestamp, arDirection: direction, trueHeading: heading.trueHeading,
                                accuracy: heading.headingAccuracy))
        }
        if let fix = location?.latestLocation, fix.horizontalAccuracy > 0, fix.timestamp != lastFix,
           now.timeIntervalSince(fix.timestamp) < 3 {
            lastFix = fix.timestamp
            if plane == nil { plane = LocalTangentPlane(origin: GeoPoint(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude)) }
            if let plane {
                alignment.add(.init(at: fix.timestamp, ar: camera,
                                    enu: plane.enu(GeoPoint(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude)),
                                    accuracy: fix.horizontalAccuracy))
            }
        }
        guard let plane else { plan = ARRouteGuidance.plan(route: [], target: nil, alignment: nil, camera: camera, cameraDirection: direction ?? 0); return }
        let enuRoute = route.map { plane.enu(GeoPoint(latitude: $0.latitude, longitude: $0.longitude)) }
        let enuTarget = target.map { plane.enu(GeoPoint(latitude: $0.latitude, longitude: $0.longitude)) }
        let next = ARRouteGuidance.plan(route: enuRoute, target: enuTarget, alignment: alignment.solution(at: now),
                                        camera: camera, cameraDirection: direction ?? 0)
        plan = next
        render(next, groundY: position.y - Self.phoneHeight, eyeY: position.y, targetLabel: targetLabel)
    }

    private func clearNodes() {
        markerNodes.forEach { $0.removeFromParentNode() }; markerNodes = []
        targetNode?.removeFromParentNode(); targetNode = nil
    }

    private func render(_ plan: ARRouteGuidance.Plan, groundY: Float, eyeY: Float, targetLabel: String) {
        // Reuse chevron nodes; hide the ones not needed this frame.
        while markerNodes.count < plan.markers.count {
            let node = Self.chevron()
            root.addChildNode(node); markerNodes.append(node)
        }
        for (index, node) in markerNodes.enumerated() {
            guard index < plan.markers.count else { node.isHidden = true; continue }
            let marker = plan.markers[index]
            node.isHidden = false
            node.position = SCNVector3(Float(marker.ar.x), groundY, Float(-marker.ar.y))
            // The chevron points along −Z; AR-plane direction θ (from +x towards −z) needs a yaw of θ − π/2.
            node.eulerAngles.y = Float(marker.direction - .pi / 2)
            // Fade arrows whose own uncertainty is large, so distant guesses look like guesses.
            node.opacity = CGFloat(max(0.25, min(1, 1.5 - marker.sigma / 4)))
        }
        if let target = plan.target {
            if targetNode == nil {
                let node = JourneyReferenceMarker.make(label: targetLabel)
                root.addChildNode(node); targetNode = node
            }
            // JourneyReferenceMarker puts its sphere 3 m up; anchor it on the ground below the boarding point.
            targetNode?.position = SCNVector3(Float(target.ar.x), groundY, Float(-target.ar.y))
            targetNode?.isHidden = false
        } else {
            targetNode?.isHidden = true
        }
    }

    /// A flat arrow head lying on the ground, pointing along −Z, 0.6 m long.
    private static func chevron() -> SCNNode {
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 0, y: 0.35))
        path.addLine(to: CGPoint(x: 0.3, y: -0.15))
        path.addLine(to: CGPoint(x: 0.12, y: -0.15))
        path.addLine(to: CGPoint(x: 0, y: 0.08))
        path.addLine(to: CGPoint(x: -0.12, y: -0.15))
        path.addLine(to: CGPoint(x: -0.3, y: -0.15))
        path.close()
        let shape = SCNShape(path: path, extrusionDepth: 0.02)
        shape.firstMaterial?.diffuse.contents = UIColor.systemTeal
        shape.firstMaterial?.emission.contents = UIColor.systemTeal.withAlphaComponent(0.6)
        shape.firstMaterial?.isDoubleSided = true
        let flat = SCNNode(geometry: shape)
        // The path's +y becomes −Z once laid flat.
        flat.eulerAngles.x = -.pi / 2
        let node = SCNNode()
        node.addChildNode(flat)
        return node
    }
}
