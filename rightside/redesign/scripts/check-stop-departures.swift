import XCTest
@main struct NavigationChecks {
    static func main() {
        let suite = XCTestSuite(name: "Integrated navigation and recovery")
        suite.addTest(JourneyStoreRegressionTests.defaultTestSuite)
        suite.addTest(DomainBridgeTests.defaultTestSuite)
        suite.addTest(NativeCoreTests.defaultTestSuite)
        suite.addTest(JourneyLanguageTests.defaultTestSuite)
        suite.addTest(NavigationGuidanceTests.defaultTestSuite)
        suite.addTest(WalkingBundleTests.defaultTestSuite)
        suite.addTest(TransitGeometryTests.defaultTestSuite)
        suite.addTest(StopDepartureTests.defaultTestSuite)
        suite.run()
        exit(suite.testRun?.hasSucceeded == true && suite.testRun?.executionCount == 111 ? 0 : 1)
    }
}
