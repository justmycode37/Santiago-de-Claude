import Foundation
import JavaScriptCore

// Mac Command Line Tools can run this even before the iOS SDK finishes installing.
// This verifies real Apple JavaScriptCore, not an iOS app build or sensor behavior.
let directory = CommandLine.arguments[1]
let context = JSContext()!
let script = try String(contentsOfFile: directory + "/domain.js", encoding: .utf8)
context.evaluateScript(script)
func call(_ method: String, _ payload: [String: Any]) throws -> Any {
    let json = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    context.exception = nil
    guard let output = context.objectForKeyedSubscript("RightSideBridge")?.invokeMethod("call", withArguments: [method, json])?.toString(), context.exception == nil else {
        fatalError(context.exception?.toString() ?? "JSC bridge missing")
    }
    let result = try JSONSerialization.jsonObject(with: Data(output.utf8)) as! [String: Any]
    guard result["ok"] as? Bool == true else { fatalError("Bridge rejected payload: \(result)") }
    return result["value"]!
}
let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: directory + "/bern-demo.json"))) as! [String: Any]
let poseAt = "2026-11-21T00:00:00Z"
let pose: [String: Any] = ["siteId":"synthetic-test", "mapVersion":"test", "sessionId":"session", "frameId":"frame", "capturedAt":poseAt,
    "transform":["convention":"T_site_camera", "storage":"column_major", "units":"meters", "siteAxes":"ENU", "cameraAxes":"x_right_y_up_z_back",
                 "matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]],
    "method":"measured_landmark", "uncertaintyMeters":0.4, "uncertaintyBasis":"independent_checkpoints", "candidatePlaceIds":[],
    "status":"accepted", "reason":"synthetic contract test", "evidence":[["source":"synthetic test", "fetchedAt":poseAt, "observedAt":poseAt, "kind":"simulated", "quality":"supported"]]]
_ = try call("validateVisualPose", ["observation":pose])
var replay = try call("createReplay", ["fixture": fixture]) as! [String: Any]
var count = 0, matched = false, lost = false
for _ in 0..<30 {
    var nav = replay["navigation"] as! [String: Any]
    if nav["phase"] as? String == "arrived" && replay["direction"] as? String == "outbound" {
        replay = try call("returnReplay", ["replay": replay]) as! [String: Any]
    }
    let before = replay["cursor"] as! Int
    if before == 26 { break }
    replay = try call("nextReplay", ["replay": replay]) as! [String: Any]
    let after = replay["cursor"] as! Int
    precondition(after > before)
    count += after - before
    nav = replay["navigation"] as! [String: Any]
    matched = matched || (nav["serviceMatch"] as? [String: Any])?["status"] as? String == "matching"
    lost = lost || (!(nav["lostTrackIds"] as! [Any]).isEmpty && nav["serviceMatch"] is NSNull)
}
let final = replay["navigation"] as! [String: Any]
precondition(count == 26 && final["phase"] as? String == "arrived" && replay["direction"] as? String == "return")
precondition(matched && lost)
precondition(context.evaluateScript("'KÖNIZ'.normalize('NFKC').toLocaleLowerCase('de-CH')")?.toString() == "köniz")
print("PASS actual Apple JavaScriptCore: 26 events, outbound/return arrivals, match/loss, de-CH normalization")
