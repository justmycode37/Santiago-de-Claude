import Foundation
import Combine
@preconcurrency import UserNotifications

@MainActor protocol JourneyNotificationCenter {
    func pendingIdentifiers() async -> [String]
    func authorize() async throws -> Bool
    func add(_ plan: JourneyReminderPlan, identifier: String) async throws
    func remove(_ identifiers: [String])
}
@MainActor private final class SystemJourneyNotificationCenter: JourneyNotificationCenter {
    private let center = UNUserNotificationCenter.current()
    func pendingIdentifiers() async -> [String] { await center.pendingNotificationRequests().map(\.identifier) }
    func authorize() async throws -> Bool { try await center.requestAuthorization(options: [.alert, .sound]) }
    func add(_ plan: JourneyReminderPlan, identifier: String) async throws {
        let content = UNMutableNotificationContent()
        content.title = plan.title; content.body = plan.body; content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, plan.at.timeIntervalSinceNow), repeats: false))
        try await center.add(request)
    }
    func remove(_ identifiers: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}

@MainActor final class JourneyReminders: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var status: String?
    private(set) var scheduled: JourneyReminderPlan?
    private var generation = UUID()
    private let center: any JourneyNotificationCenter
    private var pendingIDs = Set<String>()
    private var startup: Task<Void, Never>?
    init(center: (any JourneyNotificationCenter)? = nil) {
        let driver = center ?? SystemJourneyNotificationCenter()
        self.center = driver
        // Reconcile a previous process before allowing any new add. This touches
        // only our prefix, including the former fixed ID, never other app alerts.
        startup = Task {
            let old = await driver.pendingIdentifiers().filter { $0 == "rightside.journey-reminder" || $0.hasPrefix("rightside.journey-reminder.") }
            driver.remove(old)
        }
    }

    // Permission is requested only by the explicit passenger switch. Opt-in is
    // session-scoped: a later launch never silently schedules new reminders.
    func setEnabled(_ value: Bool, navigation: NavigationSnapshot?, session: UUID) async {
        generation = UUID(); let token = generation
        guard value else { enabled = false; cancel(); status = nil; return }
        await startup?.value
        guard token == generation else { return }
        do {
            let granted = try await center.authorize()
            guard token == generation else { return }
            enabled = granted
            status = granted ? "Timetable reminders enabled. They do not track your position and may be wrong after delays." : "Notifications are not allowed. Guidance remains available in the app."
            if granted { await update(navigation: navigation, session: session) }
        } catch { if token == generation { status = "Could not enable reminders: \(error.localizedDescription)" } }
    }
    func update(navigation: NavigationSnapshot?, session: UUID) async {
        guard enabled, let navigation, let plan = JourneyReminderPlan.make(navigation: navigation, session: session, now: Date()) else { cancel(); return }
        guard plan != scheduled else { return }
        cancel()
        let token = generation
        await startup?.value
        guard token == generation, enabled, !Task.isCancelled else { return }
        // Each outstanding add owns a distinct ID. Its late cleanup can never
        // remove a newer request, even when the notification service reorders replies.
        let identifier = plan.id + "." + token.uuidString
        pendingIDs.insert(identifier)
        do {
            try await center.add(plan, identifier: identifier)
            guard token == generation, enabled, !Task.isCancelled else {
                center.remove([identifier]); pendingIDs.remove(identifier); return
            }
            scheduled = plan
        } catch {
            center.remove([identifier]); pendingIDs.remove(identifier)
            if token == generation { status = "Could not schedule reminder: \(error.localizedDescription)" }
        }
    }
    func cancel() {
        generation = UUID(); scheduled = nil
        center.remove(Array(pendingIDs)); pendingIDs.removeAll()
    }
}
