import XCTest

@MainActor final class JourneyUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUp() async throws {
        try await super.setUp()
        await MainActor.run {
            continueAfterFailure = false
            app = XCUIApplication(); app.launchArguments = ["--ui-testing", UUID().uuidString]
            app.launch()
            // Explicitly choose English inside each isolated test preference suite.
            selectLanguage("en")
        }
    }
    private func tap(_ identifier: String, label: String? = nil) {
        let button = app.buttons[identifier]
        for _ in 0..<10 {
            if button.isHittable { break }
            app.swipeUp()
        }
        if !button.isHittable {
            for _ in 0..<12 { if button.isHittable { break }; app.swipeDown() }
        }
        XCTAssertTrue(button.waitForExistence(timeout: 5), "Missing \(identifier)")
        if let label { XCTAssertEqual(button.label, label) }
        XCTAssertTrue(button.isHittable)
        button.tap()
    }
    private func selectLanguage(_ code: String) {
        if app.buttons["choose-language"].exists { tap("choose-language") }
        else { tap("more-menu"); tap("choose-language-menu") }
        tap("language-" + code)
        tap("close-panel")
    }

    func testHomeSearchEditsTheVisibleField() throws {
        let field = app.textFields["visible-place-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Bern")
        XCTAssertEqual(field.value as? String, "Bern")
        XCTAssertEqual(app.searchFields.count, 0, "No second system search bar should receive typing")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        app.buttons["Clear search"].tap()
        XCTAssertNotEqual(field.value as? String, "Bern")
    }

    func testFrenchFullJourneyReturnAndLanguageSurviveRelaunch() throws {
        selectLanguage("fr")
        XCTAssertTrue(app.staticTexts["Où allez-vous ?"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Où allez-vous ?"].waitForExistence(timeout: 5))
        tap("more-menu"); tap("load-demo")
        XCTAssertEqual(app.staticTexts["simulated-banner"].label, "Démo · ne pas utiliser pour se déplacer")
        tap("primary-journey-action", label: "Commencer le trajet")
        tap("primary-journey-action", label: "J’ai terminé cette marche")
        XCTAssertEqual(app.staticTexts["journey-next-title"].label, "Rejoignez l’arrêt Demo Länggasse stop")
        XCTAssertTrue(app.staticTexts["journey-instruction"].label.contains("Demo 12"))
        XCTAssertTrue(app.staticTexts["journey-instruction"].label.contains("Demo Bahnhof · west arrival"))
        tap("primary-journey-action", label: "Je suis dans la zone d’attente")
        XCTAssertTrue(app.staticTexts["journey-instruction"].label.contains("ne montez pas"))
        // Restart at the critical boarding decision; both progress and French must persist.
        app.terminate(); app.launch()
        tap("more-menu"); tap("restore-journey")
        tap("primary-journey-action", label: "Je suis à bord")
        XCTAssertEqual(app.staticTexts["journey-next-title"].label, "Restez à bord jusqu’à Demo Bahnhof · west arrival")
        tap("more-menu"); tap("prepare-alighting")
        XCTAssertEqual(app.staticTexts["journey-next-title"].label, "Descendez à Demo Bahnhof · west arrival")
        tap("primary-journey-action", label: "Je suis descendu ici")
        XCTAssertEqual(app.staticTexts["journey-next-title"].label, "Rejoignez votre correspondance à Demo Bahnhof · east departure")
        for step in ["J’ai terminé cette marche", "Je suis dans la zone d’attente", "Je suis à bord", "Je suis descendu ici"] {
            tap("primary-journey-action", label: step)
        }
        XCTAssertTrue(app.staticTexts["journey-instruction"].label.contains("ne confirme pas l’entrée"))
        tap("primary-journey-action", label: "Je suis arrivé")
        tap("primary-journey-action", label: "Préparer le retour")
        let returnSteps = ["J’ai terminé cette marche", "Je suis dans la zone d’attente", "Je suis à bord", "Je suis descendu ici", "J’ai terminé cette marche", "Je suis dans la zone d’attente", "Je suis à bord", "Je suis descendu ici", "Je suis arrivé"]
        for step in returnSteps { tap("primary-journey-action", label: step) }
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "Aller-retour terminé")
        XCTAssertFalse(app.buttons["primary-journey-action"].isEnabled)
    }

    func testDepartureExplorationManualSearchAndClosePreserveGuidance() throws {
        tap("explore-departures")
        tap("departure-choose-stop")
        XCTAssertTrue(app.textFields["visible-place-search"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["use-current-location"].exists)
        tap("Cancel")
        XCTAssertTrue(app.switches["departure-offline"].exists)
        tap("close-departures")
        tap("more-menu"); tap("load-demo"); tap("primary-journey-action", label: "Start journey")
        tap("more-menu"); tap("departures-menu")
        XCTAssertTrue(app.buttons["departure-choose-stop"].waitForExistence(timeout: 5))
        tap("close-departures")
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "I completed this walk")
    }

    func testFullOutboundAndReturn() throws {
        tap("more-menu"); tap("load-demo")
        tap("primary-journey-action", label: "Start journey")
        let steps = ["I completed this walk", "I am at the waiting area", "I am on board", "I got off here", "I completed this walk", "I am at the waiting area", "I am on board", "I got off here", "I have arrived"]
        for step in steps { tap("primary-journey-action", label: step) }
        tap("primary-journey-action", label: "Plan the return journey")
        for step in steps { tap("primary-journey-action", label: step) }
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "Round trip complete")
    }
    func testWaitingProgressSurvivesRelaunch() throws {
        tap("more-menu"); tap("load-demo"); tap("primary-journey-action", label: "Start journey")
        tap("primary-journey-action", label: "I completed this walk")
        tap("primary-journey-action", label: "I am at the waiting area")
        app.terminate(); app.launch()
        tap("more-menu"); tap("restore-journey")
        tap("primary-journey-action", label: "I am on board")
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "I got off here")
    }
    func testActiveJourneyFocusAndMapDimension() throws {
        XCTAssertFalse(app.buttons["load-demo"].exists)
        tap("more-menu"); tap("load-demo"); tap("primary-journey-action", label: "Start journey")
        XCTAssertFalse(app.buttons["choose-destination"].exists)
        XCTAssertTrue(app.buttons["open-camera"].exists)
        tap("more-menu"); tap("map-dimension", label: "Switch to 3D map")
        tap("more-menu"); tap("map-dimension", label: "Switch to 2D map")
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "I completed this walk")
        XCTAssertFalse(app.otherElements["journey-timeline"].exists)
        tap("primary-journey-action", label: "I completed this walk")
        tap("primary-journey-action", label: "I am at the waiting area")
        XCTAssertTrue(app.buttons["open-camera"].exists)
        tap("primary-journey-action", label: "I am on board")
        XCTAssertFalse(app.buttons["open-camera"].exists)
        XCTAssertTrue(app.otherElements["journey-map"].exists)
        XCTAssertTrue(app.otherElements["ride-stops"].exists)
        tap("more-menu"); tap("journey-details")
        XCTAssertTrue(app.staticTexts["Your whole journey"].exists)
    }

    func testMapLegInspectionAndRecoveryKeepActivePassengerStep() throws {
        tap("more-menu"); tap("load-demo"); tap("primary-journey-action", label: "Start journey")
        tap("map-leg-1")
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "I completed this walk")
        XCTAssertTrue(app.otherElements["journey-map"].exists)
        tap("recover-journey")
        tap("I missed my connection")
        XCTAssertTrue(app.buttons["draft-origin"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["search-draft"].exists)
        tap("cancel-draft")
        XCTAssertEqual(app.buttons["primary-journey-action"].label, "I completed this walk")
    }

}
