import SwiftUI

@main
struct RightSideApp: App {
    @StateObject private var store: JourneyStore
    init() {
        NativePerformance.launchStart = ProcessInfo.processInfo.systemUptime
        let arguments = ProcessInfo.processInfo.arguments
        let testIndex = arguments.firstIndex(of: "--ui-testing")
        let token = testIndex.flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        let testURL = token.map { FileManager.default.temporaryDirectory.appendingPathComponent("rightside-ui-\($0).json") }
        _store = StateObject(wrappedValue: JourneyStore(cacheURL: testURL))
    }
    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
                .tint(.rightSideTeal)
        }
    }
}
