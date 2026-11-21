import XCTest
@main struct VehicleChecks {
    static func main() {
        let suite = XCTestSuite(name: "Local vehicle and geometry checks")
        suite.addTest(VehicleEvidenceTests.defaultTestSuite)
        suite.addTest(TransportDecoderTests.defaultTestSuite)
        suite.run()
        exit(suite.testRun?.hasSucceeded == true && (suite.testRun?.executionCount ?? 0) >= 17 ? 0 : 1)
    }
}
