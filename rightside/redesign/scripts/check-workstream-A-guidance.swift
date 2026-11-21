import XCTest
@main struct MapGuidanceRegressionChecks {
    static func main() {
        let suite = GuidanceTests.defaultTestSuite
        suite.run()
        exit(suite.testRun?.hasSucceeded == true && suite.testRun?.executionCount == 9 ? 0 : 1)
    }
}
