import XCTest

@main struct RecoveryChecks {
    static func main() {
        let suite = XCTestSuite(name: "Journey recovery with actual Apple JavaScriptCore")
        suite.addTest(JourneyStoreRegressionTests.defaultTestSuite)
        suite.addTest(DomainBridgeTests.defaultTestSuite)
        suite.addTest(NativeCoreTests.defaultTestSuite)
        suite.run()
        exit(suite.testRun?.hasSucceeded == true && (suite.testRun?.executionCount ?? 0) == 26 ? 0 : 1)
    }
}
