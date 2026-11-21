// Compile with JourneyLanguage.swift and JourneyLanguageTests.swift, passing
// -D HILL_CLIMB_LANGUAGE_HARNESS. This runner needs Foundation/XCTest, no iOS host.
import Foundation
import XCTest

@main struct LanguageChecks {
    static func main() {
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--write-language") {
            JourneyLanguage.preferences.set(args[index + 1], forKey: JourneyLanguage.preferenceKey)
            precondition(JourneyLanguage.preferences.synchronize())
            print("Persisted \(JourneyLanguage.selected.rawValue)")
            return
        }
        if let index = args.firstIndex(of: "--expect-language") {
            precondition(JourneyLanguage.selected.rawValue == args[index + 1])
            print("PASS fresh-process language restoration: \(JourneyLanguage.selected.rawValue)")
            return
        }
        print("Checking \(JourneyText.allCases.count) keys × \(JourneyLanguage.allCases.count) languages; \(JourneyGuidancePhase.allCases.count) phases")
        let suite = JourneyLanguageTests.defaultTestSuite
        suite.run()
        exit(suite.testRun?.hasSucceeded == true && suite.testRun?.executionCount == 8 ? 0 : 1)
    }
}
