import Foundation
import Combine

enum DeparturePlanOutcome: Equatable { case ready, empty, failed(String) }

/// One sheet owns one draft initialization and its cancellable planning operation.
/// Navigation back to the root reactivates it without replacing the user's draft.
@MainActor final class DeparturePresentation: ObservableObject {
    @Published private(set) var planning = false
    @Published private(set) var outcome: DeparturePlanOutcome?
    private var initialized = false
    private var visible = false
    private var generation = UUID()
    private var task: Task<Void, Never>?

    @discardableResult func activate() -> Bool {
        visible = true
        guard !initialized else { return false }
        initialized = true
        return true
    }
    func deactivate() {
        visible = false; generation = UUID()
        task?.cancel(); task = nil; planning = false
    }
    func plan(operation: @escaping @MainActor () async -> DeparturePlanOutcome,
              onReady: @escaping @MainActor () -> Void) {
        guard visible else { return }
        task?.cancel(); generation = UUID()
        let token = generation
        planning = true; outcome = nil
        task = Task { [weak self] in
            let result = await operation()
            guard let self, !Task.isCancelled, self.visible, self.generation == token else { return }
            self.planning = false; self.task = nil; self.outcome = result
            if result == .ready { onReady() }
        }
    }
}

enum DepartureServiceClock {
    static let zone = TimeZone(identifier: "Europe/Zurich")!
    /// Date and numeric UTC offset remain visible at midnight and repeated DST wall times.
    static func label(_ date: Date, language: JourneyLanguage) -> String {
        let format = DateFormatter()
        format.locale = language.locale; format.timeZone = zone
        format.dateFormat = "d MMM yyyy HH:mm xxx"
        return format.string(from: date)
    }
}
