import XCTest
#if !HILL_CLIMB_LANGUAGE_HARNESS
@testable import RightSide
#endif

final class JourneyLanguageTests: XCTestCase {
    private func guidance(_ language: JourneyLanguage, _ phase: JourneyGuidancePhase, canReturn: Bool = true) -> JourneyGuidance {
        JourneyGuidance(language: language, phase: phase, stop: "Bern, Länggasse", destination: "Bern, Bahnhof",
                        line: "12", headsign: "Zentrum Paul Klee", canReturn: canReturn)
    }

    func testEveryKeyHasNonemptyEnglishGermanFrenchAndMatchingTokens() throws {
        XCTAssertEqual(Set(JourneyLanguage.catalogue.keys), Set(JourneyText.allCases))
        let tokenPattern = try NSRegularExpression(pattern: #"\{[0-9]+\}"#)
        func tokens(_ text: String) -> [String] {
            tokenPattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { String(text[Range($0.range, in: text)!]) }.sorted()
        }
        for key in JourneyText.allCases {
            let translations = try XCTUnwrap(JourneyLanguage.catalogue[key])
            XCTAssertEqual(Set(translations.keys), Set(JourneyLanguage.allCases), key.rawValue)
            let english = try XCTUnwrap(translations[.en])
            for language in JourneyLanguage.allCases {
                let template = try XCTUnwrap(translations[language])
                XCTAssertFalse(template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(language) \(key)")
                XCTAssertEqual(tokens(template), tokens(english), "\(language) \(key)")
                let rendered = language.render(key, values: ["Bern, Bahnhof", "12", "Zentrum Paul Klee"])
                XCTAssertFalse(rendered.contains("{0}"), "\(language) \(key)")
                XCTAssertFalse(rendered.contains("{1}"), "\(language) \(key)")
                XCTAssertFalse(rendered.contains("{2}"), "\(language) \(key)")
            }
        }
    }

    func testEveryPhaseHasExpectedGermanAndFrenchActionAndDistinctInstruction() {
        let phases: [JourneyGuidancePhase] = [.preview, .walking, .approaching, .waiting, .riding, .alighting, .transfer, .finalWalk, .arrived, .unknown]
        let expected: [JourneyLanguage: [String]] = [
            .de: ["Reise starten", "Ich habe diesen Fussweg beendet", "Ich bin am Wartebereich", "Ich bin eingestiegen", "Ich bin hier ausgestiegen", "Ich bin hier ausgestiegen", "Ich habe diesen Fussweg beendet", "Ich bin angekommen", "Rückreise planen", "Reisedetails"],
            .fr: ["Commencer le trajet", "J’ai terminé cette marche", "Je suis dans la zone d’attente", "Je suis à bord", "Je suis descendu ici", "Je suis descendu ici", "J’ai terminé cette marche", "Je suis arrivé", "Préparer le retour", "Détails du trajet"]
        ]
        XCTAssertEqual(Set(phases), Set(JourneyGuidancePhase.allCases))
        for language in [JourneyLanguage.de, .fr] {
            var instructions = Set<String>()
            for (index, phase) in phases.enumerated() {
                let value = guidance(language, phase)
                XCTAssertEqual(value.action, expected[language]![index], "\(language) \(phase)")
                XCTAssertFalse(value.title.isEmpty)
                XCTAssertFalse(value.instruction.isEmpty)
                XCTAssertNotEqual(value.instruction, guidance(.en, phase).instruction)
                instructions.insert(value.instruction)
            }
            XCTAssertEqual(instructions.count, phases.count, "Each phase must explain its own next action")
            XCTAssertEqual(guidance(language, .arrived, canReturn: false).actionKey, .roundTripComplete)
            XCTAssertEqual(guidance(language, .arrived, canReturn: false).instruction, language.text(.roundTripInstruction))
        }
    }

    func testOriginalSignsAndLineArePreservedInEveryRelevantPhase() {
        for language in JourneyLanguage.allCases {
            let approach = guidance(language, .approaching)
            XCTAssertTrue(approach.title.contains("Bern, Länggasse"))
            for sign in ["Bern, Länggasse", "12", "Zentrum Paul Klee"] { XCTAssertTrue(approach.instruction.contains(sign)) }
            let waiting = guidance(language, .waiting)
            for sign in ["12", "Zentrum Paul Klee"] {
                XCTAssertTrue(waiting.title.contains(sign)); XCTAssertTrue(waiting.instruction.contains(sign))
            }
            for phase in [JourneyGuidancePhase.walking, .riding, .alighting, .transfer, .finalWalk] {
                XCTAssertTrue(guidance(language, phase).title.contains("Bern, Bahnhof"))
                XCTAssertTrue(guidance(language, phase).instruction.contains("Bern, Bahnhof"))
            }
            // Tokens, percent signs, accents and quotes in source data must remain literal.
            let sign = "Bern {1} 100% «Bärenplatz»"
            XCTAssertEqual(language.text(.from, sign), language.text(.from, "SENTINEL").replacingOccurrences(of: "SENTINEL", with: sign))
            XCTAssertTrue(language.text(.waitingTitle, "12 {1}", sign).contains("12 {1}"))
        }
    }

    func testCriticalWarningsHaveLocalizedCautionsAndRecovery() {
        let warningKeys: [JourneyText] = [.offline, .unavailable, .conflicting, .waitingUnverified, .walkUnavailable, .replanWarning, .boardingUnavailable, .stopReference, .matching, .vehicleUnknown, .pathUnverified, .correctionCaution, .savedCaution, .accessCaution, .errorHelp, .locationHelp, .noSaved, .restoredOffline, .savingFailed, .restoreFailed, .staleLocation]
        for language in [JourneyLanguage.de, .fr] {
            for key in warningKeys {
                XCTAssertNotEqual(language.text(key), JourneyLanguage.en.text(key), key.rawValue)
                XCTAssertFalse(language.text(key).isEmpty)
            }
        }
        XCTAssertTrue(JourneyLanguage.de.text(.conflicting).contains("Steige erst ein, wenn beides stimmt"))
        XCTAssertTrue(JourneyLanguage.fr.text(.conflicting).contains("ne montez que si les deux correspondent"))
        XCTAssertTrue(guidance(.de, .waiting).instruction.contains("steige nicht ein"))
        XCTAssertTrue(guidance(.fr, .waiting).instruction.contains("ne montez pas"))
        XCTAssertTrue(guidance(.de, .riding).instruction.contains("Fahrplan bestätigt deinen Standort nicht"))
        XCTAssertTrue(guidance(.fr, .riding).instruction.contains("L’horaire ne confirme pas votre position"))
        XCTAssertTrue(guidance(.de, .finalWalk).instruction.contains("Kartenmarkierung bestätigt den Eingang nicht"))
        XCTAssertTrue(guidance(.fr, .finalWalk).instruction.contains("ne confirme pas l’entrée"))
    }

    func testKnownAppMessagesTranslateAndUnknownProviderMessagesStayVerbatim() {
        for language in JourneyLanguage.allCases {
            for (original, key) in JourneyLanguage.appMessageKeys {
                XCTAssertEqual(language.appMessage(original), language.text(key))
            }
            let original = "Provider said: Bern, Bahnhof • 12 • Gleis {0}"
            XCTAssertTrue(language.appMessage(original).hasSuffix(original))
            XCTAssertEqual(language.appMessage("Choose an itinerary and start it to replace current guidance. " + original), language.text(.chooseItinerary) + "\n" + language.text(.originalMessage, original))
            XCTAssertTrue(language.appMessage("Could not restore the saved journey: corrupt file").hasPrefix(language.text(.restoreFailed)))
            XCTAssertTrue(language.appMessage("Guidance is active, but saving failed: disk full").hasPrefix(language.text(.savingFailed)))
        }
    }

    func testSafeLanguageAndPhaseFallbacks() {
        XCTAssertEqual(JourneyLanguage.resolve(nil), .en)
        for code in ["", "ar", "xx-CH", "not-a-language"] { XCTAssertEqual(JourneyLanguage.resolve(code), .en) }
        XCTAssertEqual(JourneyLanguage.resolve("de-CH"), .de)
        XCTAssertEqual(JourneyLanguage.resolve("FR_ch"), .fr)
        XCTAssertEqual(JourneyGuidancePhase(nil), .preview)
        XCTAssertEqual(JourneyGuidancePhase("provider-new-phase"), .unknown)
        XCTAssertEqual(guidance(.de, .unknown).actionKey, .details)
    }

    func testLanguagePreferenceCanBeReloadedWithoutDeviceLocale() throws {
        let name = "rightside-language-unit-" + UUID().uuidString
        let first = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { first.removePersistentDomain(forName: name) }
        for language in JourneyLanguage.allCases {
            first.set(language.rawValue, forKey: JourneyLanguage.preferenceKey)
            let reloaded = try XCTUnwrap(UserDefaults(suiteName: name))
            XCTAssertEqual(JourneyLanguage.resolve(reloaded.string(forKey: JourneyLanguage.preferenceKey)), language)
        }
    }

    func testExistingEnglishProgressionLabelsRemainStable() {
        let phases: [JourneyGuidancePhase] = [.preview, .walking, .approaching, .waiting, .riding, .transfer, .approaching, .waiting, .alighting, .finalWalk, .arrived]
        let expected = ["Start journey", "I completed this walk", "I am at the waiting area", "I am on board", "I got off here", "I completed this walk", "I am at the waiting area", "I am on board", "I got off here", "I have arrived", "Plan the return journey"]
        XCTAssertEqual(phases.map { guidance(.en, $0).action }, expected)
        XCTAssertEqual(guidance(.en, .arrived, canReturn: false).action, "Round trip complete")
    }
}
