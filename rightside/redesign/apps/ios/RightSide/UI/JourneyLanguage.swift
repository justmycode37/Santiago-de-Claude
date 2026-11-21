import Foundation

/// Deliberately bounded pilot. Sign names are data, never localization keys.
enum JourneyLanguage: String, CaseIterable, Identifiable {
    case en, de, fr
    var id: String { rawValue }
    var nativeName: String { switch self { case .en: "English"; case .de: "Deutsch"; case .fr: "Français" } }
    var locale: Locale { Locale(identifier: rawValue == "en" ? "en_CH" : rawValue == "de" ? "de_CH" : "fr_CH") }
    static let preferenceKey = "journey-guidance-language"
    /// A test token isolates preferences while preserving them across that test's relaunch.
    static var preferences: UserDefaults {
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--ui-testing"), args.indices.contains(index + 1) {
            return UserDefaults(suiteName: "rightside-language-ui-" + args[index + 1]) ?? .standard
        }
        return .standard
    }
    static var selected: JourneyLanguage { resolve(preferences.string(forKey: preferenceKey)) }
    static func resolve(_ code: String?) -> JourneyLanguage {
        guard let code else { return .en }
        return JourneyLanguage(rawValue: code.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? "") ?? .en
    }

    func text(_ key: JourneyText, _ values: String...) -> String { render(key, values: values) }
    /// Replace tokens in a single pass, so inserted sign names are never interpreted as tokens.
    func render(_ key: JourneyText, values: [String]) -> String {
        let template = Self.catalogue[key]![self] ?? Self.catalogue[key]![.en]!
        var result = ""
        var index = template.startIndex
        while index < template.endIndex {
            if template[index] == "{", let end = template[index...].firstIndex(of: "}"),
               let number = Int(template[template.index(after: index)..<end]), values.indices.contains(number) {
                result += values[number]; index = template.index(after: end)
            } else { result.append(template[index]); index = template.index(after: index) }
        }
        return result
    }

    static let catalogue: [JourneyText: [JourneyLanguage: String]] = [
        .chooseBoth: [.en: "Select an origin and destination from the place suggestions.", .de: "Wähle Start und Ziel aus den Ortsvorschlägen.", .fr: "Choisissez le départ et la destination parmi les suggestions."],
        .noItineraries: [.en: "No validated itineraries returned. Current guidance is preserved.", .de: "Keine geprüften Verbindungen gefunden. Deine aktuelle Reise bleibt erhalten.", .fr: "Aucun itinéraire validé trouvé. Votre guidage actuel est conservé."],
        .demoScenario: [.en: "Simulated Bern scenario. Times, geometry, platforms and events are invented.", .de: "Simulierte Reise in Bern. Zeiten, Routenverlauf, Gleise und Ereignisse sind erfunden.", .fr: "Scénario simulé à Berne. Les horaires, tracés, quais et événements sont fictifs."],
        .liveCaution: [.en: "Live source itinerary. Walking paths, waiting areas and exact trip refresh are unverified.", .de: "Verbindung aus aktueller Quelle. Fusswege, Wartebereiche und die Aktualisierung genau dieser Fahrt sind nicht bestätigt.", .fr: "Itinéraire issu d’une source actuelle. Les chemins piétons, zones d’attente et l’actualisation de cette course précise ne sont pas vérifiés."],
        .demoLoaded: [.en: "Simulated Bern demo loaded. Start it to begin the labelled scenario.", .de: "Simulierte Bern-Demo geladen. Starte sie, um das gekennzeichnete Szenario zu beginnen.", .fr: "Démo simulée de Berne chargée. Démarrez-la pour commencer le scénario indiqué."],
        .manualDemo: [.en: "Manual simulated journey. Reload the demo to use scripted events.", .de: "Manuell bestätigte simulierte Reise. Lade die Demo neu, um vorgegebene Ereignisse zu verwenden.", .fr: "Trajet simulé à progression manuelle. Rechargez la démo pour utiliser les événements prédéfinis."],
        .completeFirst: [.en: "Complete the current journey before starting a return.", .de: "Beende die aktuelle Reise, bevor du die Rückreise startest.", .fr: "Terminez le trajet actuel avant de commencer le retour."],
        .startFirst: [.en: "Start a journey before replanning.", .de: "Starte eine Reise, bevor du neu planst.", .fr: "Commencez un trajet avant de le recalculer."],
        .resumed: [.en: "Resumed current journey.", .de: "Aktuelle Reise fortgesetzt.", .fr: "Trajet actuel repris."],
        .noSaved: [.en: "No saved journey is available.", .de: "Keine gespeicherte Reise verfügbar.", .fr: "Aucun trajet enregistré disponible."],
        .restoredDemo: [.en: "Restored simulated scenario at its saved clock.", .de: "Simuliertes Szenario zur gespeicherten Uhrzeit wiederhergestellt.", .fr: "Scénario simulé restauré à son heure enregistrée."],
        .restoredOffline: [.en: "Restored saved guidance offline. Original evidence ages are preserved; search again for current options.", .de: "Gespeicherte Reise offline wiederhergestellt. Hinweise behalten ihr ursprüngliches Alter; suche neu nach aktuellen Verbindungen.", .fr: "Guidage enregistré restauré hors ligne. Les informations conservent leur ancienneté d’origine ; relancez une recherche pour les trajets actuels."],
        .refreshUnavailable: [.en: "Exact trip refresh is unavailable: the community source has no authoritative trip occurrence ID. Replan from an explicitly selected current place.", .de: "Diese konkrete Fahrt kann nicht aktualisiert werden: Die öffentliche Quelle bietet keine eindeutige Fahrtkennung. Wähle deinen aktuellen Ort und plane neu.", .fr: "Impossible d’actualiser cette course précise : la source publique ne fournit pas d’identifiant de course fiable. Sélectionnez votre position actuelle et recalculez le trajet."],
        .cameraDemo: [.en: "Native camera evidence is separate from the simulated scenario.", .de: "Echte Kamerahinweise sind vom simulierten Szenario getrennt.", .fr: "Les indices réels de la caméra sont distincts du scénario simulé."],
        .staleLocation: [.en: "Received an old or future location. Request again or select your current place manually.", .de: "Veralteter oder zukünftiger Standort empfangen. Fordere ihn erneut an oder wähle deinen aktuellen Ort manuell.", .fr: "Position ancienne ou future reçue. Réessayez ou sélectionnez votre position manuellement."],
        .approximateLocation: [.en: "Approximate location selected as the search origin. No street side, floor or waiting area is confirmed.", .de: "Ungefährer Standort als Startpunkt gewählt. Strassenseite, Stockwerk und Wartebereich sind nicht bestätigt.", .fr: "Position approximative choisie comme départ. Le côté de la rue, l’étage et la zone d’attente ne sont pas confirmés."],
        .chooseItinerary: [.en: "Choose an itinerary and start it to replace current guidance.", .de: "Wähle eine Verbindung und starte sie, um deine aktuelle Reise zu ersetzen.", .fr: "Choisissez un itinéraire et démarrez-le pour remplacer le guidage actuel."],
        .savingFailed: [.en: "Guidance is active, but saving failed. Keep the app open and check the original message.", .de: "Die Reisebegleitung ist aktiv, konnte aber nicht gespeichert werden. Lass die App geöffnet und prüfe die Originalmeldung.", .fr: "Le guidage est actif, mais l’enregistrement a échoué. Gardez l’app ouverte et consultez le message d’origine."],
        .restoreFailed: [.en: "The saved journey could not be opened. Your current journey is preserved; try again or plan a new journey.", .de: "Die gespeicherte Reise konnte nicht geöffnet werden. Deine aktuelle Reise bleibt erhalten; versuche es erneut oder plane eine neue Reise.", .fr: "Impossible d’ouvrir le trajet enregistré. Votre trajet actuel est conservé ; réessayez ou planifiez un nouveau trajet."],

        .language: [.en: "Language", .de: "Sprache", .fr: "Langue"],
        .languageHelp: [.en: "Choose the language for journey guidance. Original sign names stay unchanged.", .de: "Wähle die Sprache für deine Reisebegleitung. Namen auf Schildern bleiben unverändert.", .fr: "Choisissez la langue du guidage. Les noms affichés sur les panneaux restent inchangés."],
        .findingJourneys: [.en: "Finding journeys…", .de: "Verbindungen werden gesucht…", .fr: "Recherche de trajets…"],
        .journeys: [.en: "Journeys", .de: "Verbindungen", .fr: "Trajets"],
        .from: [.en: "From {0}", .de: "Von {0}", .fr: "Depuis {0}"],
        .startingPoint: [.en: "your starting point", .de: "deinem Startpunkt", .fr: "votre point de départ"],
        .demo: [.en: "Demo · not for navigation", .de: "Demo · nicht zur Navigation", .fr: "Démo · ne pas utiliser pour se déplacer"],
        .offline: [.en: "Offline · check current departure signs.", .de: "Offline · prüfe die aktuellen Abfahrtsanzeigen.", .fr: "Hors ligne · vérifiez les panneaux de départ actuels."],
        .camera: [.en: "Camera addition", .de: "Kameraunterstützung", .fr: "Aide par caméra"],
        .resume: [.en: "Resume", .de: "Fortsetzen", .fr: "Reprendre"],
        .back: [.en: "Back", .de: "Zurück", .fr: "Retour"],
        .startingFrom: [.en: "Starting from", .de: "Startpunkt", .fr: "Point de départ"],
        .goingTo: [.en: "Going to", .de: "Ziel", .fr: "Destination"],
        .whereNow: [.en: "Where are you now?", .de: "Wo bist du jetzt?", .fr: "Où êtes-vous maintenant ?"],
        .done: [.en: "Done", .de: "Fertig", .fr: "Terminé"],
        .journeyStop: [.en: "Journey stop", .de: "Haltestelle", .fr: "Arrêt du trajet"],
        .referenceLocation: [.en: "{0} · reference location", .de: "{0} · Referenzposition", .fr: "{0} · position de référence"],
        .mappedWalk: [.en: "Mapped walking route · follow local signs", .de: "Kartierter Fussweg · folge den Schildern vor Ort", .fr: "Itinéraire piéton sur la carte · suivez les panneaux sur place"],
        .details: [.en: "Journey details", .de: "Reisedetails", .fr: "Détails du trajet"],
        .changeJourney: [.en: "Change journey", .de: "Reise ändern", .fr: "Modifier le trajet"],
        .map2D: [.en: "2D map", .de: "2D-Karte", .fr: "Carte 2D"],
        .map3D: [.en: "3D map", .de: "3D-Karte", .fr: "Carte 3D"],
        .switch2D: [.en: "Switch to 2D map", .de: "Zur 2D-Karte wechseln", .fr: "Passer à la carte 2D"],
        .switch3D: [.en: "Switch to 3D map", .de: "Zur 3D-Karte wechseln", .fr: "Passer à la carte 3D"],
        .wholeMap: [.en: "Show whole journey", .de: "Ganze Reise anzeigen", .fr: "Afficher tout le trajet"],
        .replan: [.en: "Plan again from here", .de: "Ab hier neu planen", .fr: "Recalculer depuis ici"],
        .stopNext: [.en: "My stop is next", .de: "Meine Haltestelle kommt als Nächstes", .fr: "Mon arrêt est le prochain"],
        .nextSimulation: [.en: "Next simulated event", .de: "Nächstes simuliertes Ereignis", .fr: "Événement simulé suivant"],
        .savedJourney: [.en: "Saved journey", .de: "Gespeicherte Reise", .fr: "Trajet enregistré"],
        .swap: [.en: "Swap places", .de: "Start und Ziel tauschen", .fr: "Inverser départ et arrivée"],
        .tryDemo: [.en: "Try demo", .de: "Demo ausprobieren", .fr: "Essayer la démo"],
        .settings: [.en: "Settings", .de: "Einstellungen", .fr: "Réglages"],
        .more: [.en: "More", .de: "Mehr", .fr: "Plus"],
        .walkDirections: [.en: "Walking directions · {0} min", .de: "Wegbeschreibung · {0} Min.", .fr: "Itinéraire à pied · {0} min"],
        .appleEstimate: [.en: "Apple Maps estimate. Allow extra time if it exceeds the scheduled walk. Entrances and step-free access may be unverified.", .de: "Schätzung von Apple Maps. Plane mehr Zeit ein, wenn der Fussweg länger als vorgesehen dauert. Eingänge und stufenlose Zugänge sind möglicherweise nicht geprüft.", .fr: "Estimation Apple Plans. Prévoyez plus de temps si la marche dépasse la durée prévue. Les entrées et les accès sans marches peuvent ne pas être vérifiés."],
        .mapCaution: [.en: "Dashed map lines show transit overviews, not surveyed paths. Stop pins are reference locations, not verified waiting areas.", .de: "Gestrichelte Kartenlinien zeigen den Streckenverlauf, keine geprüften Wege. Haltestellenmarkierungen sind Referenzpositionen, keine bestätigten Wartebereiche.", .fr: "Les lignes en pointillés donnent un aperçu du trajet, pas un chemin vérifié. Les repères d’arrêt sont des positions de référence, pas des zones d’attente vérifiées."],
        .correctLeg: [.en: "Correct this leg", .de: "Diesen Abschnitt korrigieren", .fr: "Corriger cette étape"],
        .approachingChoice: [.en: "Approaching the stop", .de: "Auf dem Weg zur Haltestelle", .fr: "En route vers l’arrêt"],
        .waitingChoice: [.en: "At the waiting area", .de: "Am Wartebereich", .fr: "Dans la zone d’attente"],
        .ridingChoice: [.en: "On board", .de: "Im Fahrzeug", .fr: "À bord"],
        .alightingChoice: [.en: "Preparing to get off", .de: "Ausstieg vorbereiten", .fr: "Préparation à la descente"],
        .walkingChoice: [.en: "I am on this walk", .de: "Ich bin auf diesem Fussweg", .fr: "Je suis sur ce parcours à pied"],
        .correctionCaution: [.en: "This changes your recorded progress. It does not infer your physical location.", .de: "Dies ändert deinen gespeicherten Fortschritt. Dein tatsächlicher Standort wird daraus nicht abgeleitet.", .fr: "Cela modifie votre progression enregistrée. Votre position réelle n’en est pas déduite."],
        .arriveBy: [.en: "Arrive by", .de: "Ankunft bis", .fr: "Arrivée avant"],
        .departAt: [.en: "Depart at", .de: "Abfahrt um", .fr: "Départ à"],
        .arriveToggle: [.en: "Arrive by this time", .de: "Bis zu dieser Zeit ankommen", .fr: "Arriver avant cette heure"],
        .leaveNow: [.en: "Leave now", .de: "Jetzt losfahren", .fr: "Partir maintenant"],
        .zurichTime: [.en: "Times in Europe/Zurich", .de: "Zeiten in Europe/Zurich", .fr: "Heures : Europe/Zurich"],
        .departure: [.en: "Departure", .de: "Abfahrt", .fr: "Départ"],
        .whereTo: [.en: "Where to?", .de: "Wohin?", .fr: "Où allez-vous ?"],
        .to: [.en: "To", .de: "Nach", .fr: "Vers"],
        .chooseStart: [.en: "Choose starting point", .de: "Startpunkt wählen", .fr: "Choisir le point de départ"],
        .arriveTime: [.en: "Arrive {0}", .de: "Ankunft {0}", .fr: "Arrivée {0}"],
        .departTime: [.en: "Depart {0}", .de: "Abfahrt {0}", .fr: "Départ {0}"],
        .findJourneys: [.en: "Find journeys", .de: "Verbindungen suchen", .fr: "Chercher des trajets"],
        .address: [.en: "Address, place or station", .de: "Adresse, Ort oder Haltestelle", .fr: "Adresse, lieu ou arrêt"],
        .transit: [.en: "Transit", .de: "Öffentlicher Verkehr", .fr: "Transports publics"],
        .direct: [.en: "Direct", .de: "Direkt", .fr: "Direct"],
        .oneChange: [.en: "1 change", .de: "1 Umstieg", .fr: "1 correspondance"],
        .changes: [.en: "{0} changes", .de: "{0} Umstiege", .fr: "{0} correspondances"],
        .overview: [.en: "YOUR JOURNEY OVERVIEW", .de: "DEINE REISEÜBERSICHT", .fr: "APERÇU DE VOTRE TRAJET"],
        .arrivalConfirmed: [.en: "ARRIVAL CONFIRMED", .de: "ANKUNFT BESTÄTIGT", .fr: "ARRIVÉE CONFIRMÉE"],
        .step: [.en: "STEP {0} OF {1}", .de: "SCHRITT {0} VON {1}", .fr: "ÉTAPE {0} SUR {1}"],
        .platformValue: [.en: "Platform {0}", .de: "Gleis / Kante {0}", .fr: "Voie / quai {0}"],
        .checkDepartures: [.en: "Check departure signs", .de: "Abfahrtsanzeigen prüfen", .fr: "Vérifiez les panneaux de départ"],
        .unavailable: [.en: "Do not board. This service is unavailable.", .de: "Nicht einsteigen. Diese Verbindung ist nicht verfügbar.", .fr: "Ne montez pas. Ce service est indisponible."],
        .conflicting: [.en: "Vehicle evidence conflicts. Check the line and full destination; do not board until both match.", .de: "Die Fahrzeughinweise widersprechen sich. Prüfe Linie und vollständiges Fahrtziel. Steige erst ein, wenn beides stimmt.", .fr: "Les indices sur le véhicule se contredisent. Vérifiez la ligne et la destination complète ; ne montez que si les deux correspondent."],
        .waitingUnverified: [.en: "Check the stop sign; waiting area unverified.", .de: "Prüfe das Haltestellenschild; der Wartebereich ist nicht bestätigt.", .fr: "Vérifiez le panneau de l’arrêt ; la zone d’attente n’est pas vérifiée."],
        .walkMinutes: [.en: "{0} min walk", .de: "{0} Min. zu Fuss", .fr: "{0} min à pied"],
        .followSigns: [.en: "Follow local signs.", .de: "Folge den Schildern vor Ort.", .fr: "Suivez les panneaux sur place."],
        .walkUnavailable: [.en: "Walking path unavailable. Follow local signs.", .de: "Fussweg nicht verfügbar. Folge den Schildern vor Ort.", .fr: "Chemin piéton indisponible. Suivez les panneaux sur place."],
        .replanWarning: [.en: "This connection needs attention. Replan before boarding.", .de: "Diese Verbindung muss geprüft werden. Plane vor dem Einsteigen neu.", .fr: "Cette correspondance doit être vérifiée. Recalculez le trajet avant de monter."],
        .nextDestination: [.en: "Your next destination", .de: "Dein nächstes Ziel", .fr: "Votre prochaine destination"],
        .complete: [.en: "Journey complete", .de: "Reise abgeschlossen", .fr: "Trajet terminé"],
        .rideTitle: [.en: "Ride to {0}", .de: "Fahre bis {0}", .fr: "Restez à bord jusqu’à {0}"],
        .alightTitle: [.en: "Get off at {0}", .de: "Steige bei {0} aus", .fr: "Descendez à {0}"],
        .approachTitle: [.en: "Go to the stop {0}", .de: "Gehe zur Haltestelle {0}", .fr: "Rejoignez l’arrêt {0}"],
        .waitingTitle: [.en: "Check {0} towards {1}", .de: "Prüfe {0} Richtung {1}", .fr: "Vérifiez {0} direction {1}"],
        .walkTitle: [.en: "Walk to {0}", .de: "Gehe zu {0}", .fr: "Marchez jusqu’à {0}"],
        .transferTitle: [.en: "Walk to your connection at {0}", .de: "Gehe zum Anschluss bei {0}", .fr: "Rejoignez votre correspondance à {0}"],
        .finalWalkTitle: [.en: "Walk to the entrance of {0}", .de: "Gehe zum Eingang von {0}", .fr: "Rejoignez l’entrée de {0}"],
        .serviceFallback: [.en: "your service", .de: "deine Verbindung", .fr: "votre service"],
        .destinationFallback: [.en: "the signed destination", .de: "das angezeigte Fahrtziel", .fr: "la destination affichée"],
        .stopFallback: [.en: "your next stop", .de: "deine nächste Haltestelle", .fr: "votre prochain arrêt"],
        .previewInstruction: [.en: "Review the route, stops and destination before starting.", .de: "Prüfe vor dem Start die Route, Haltestellen und das Ziel.", .fr: "Vérifiez l’itinéraire, les arrêts et la destination avant de partir."],
        .walkInstruction: [.en: "Follow a safe pedestrian route to {0}. Check local signs and crossings.", .de: "Folge einem sicheren Fussweg zu {0}. Achte auf Schilder und Übergänge.", .fr: "Suivez un chemin piéton sûr vers {0}. Vérifiez les panneaux et les passages piétons."],
        .approachInstruction: [.en: "Approach {0} using a safe pedestrian route. Find the signed stop for {1} towards {2}; a map pin does not verify the waiting area.", .de: "Gehe auf einem sicheren Fussweg zu {0}. Suche die ausgeschilderte Haltestelle für {1} Richtung {2}; die Kartenmarkierung bestätigt keinen Wartebereich.", .fr: "Rejoignez {0} par un chemin piéton sûr. Cherchez l’arrêt indiqué pour {1} direction {2} ; le repère sur la carte ne confirme pas la zone d’attente."],
        .waitingInstruction: [.en: "Before boarding, compare the vehicle’s line {0} AND full destination {1} with the signs. If either is unclear or different, do not board; check with the driver or staff.", .de: "Vergleiche vor dem Einsteigen die Linie {0} UND das vollständige Fahrtziel {1} am Fahrzeug mit den Schildern. Ist etwas unklar oder anders, steige nicht ein; frage das Fahrpersonal.", .fr: "Avant de monter, vérifiez sur le véhicule la ligne {0} ET la destination complète {1}. Si l’une est illisible ou différente, ne montez pas ; demandez au personnel."],
        .ridingInstruction: [.en: "Stay on board until {0}. Watch the stop display or listen to announcements. Timetables do not confirm your location.", .de: "Bleibe bis {0} im Fahrzeug. Achte auf die Haltestellenanzeige oder Ansagen. Der Fahrplan bestätigt deinen Standort nicht.", .fr: "Restez à bord jusqu’à {0}. Regardez l’affichage des arrêts ou écoutez les annonces. L’horaire ne confirme pas votre position."],
        .alightingInstruction: [.en: "Prepare to get off at {0}. Confirm the stop name and wait for the vehicle to stop safely before leaving.", .de: "Bereite den Ausstieg bei {0} vor. Prüfe den Haltestellennamen und warte, bis das Fahrzeug sicher hält.", .fr: "Préparez-vous à descendre à {0}. Vérifiez le nom de l’arrêt et attendez l’arrêt complet du véhicule."],
        .transferInstruction: [.en: "Walk to the connection at {0}. Follow signs and safe crossings; verify the next line and destination before boarding.", .de: "Gehe zum Anschluss bei {0}. Folge den Schildern und sicheren Übergängen; prüfe vor dem Einsteigen die nächste Linie und das Fahrtziel.", .fr: "Rejoignez votre correspondance à {0}. Suivez les panneaux et les passages sûrs ; vérifiez la prochaine ligne et sa destination avant de monter."],
        .finalInstruction: [.en: "Find the actual entrance of {0} using local signs. The map pin does not verify the entrance. Confirm only when you have arrived.", .de: "Suche anhand der Schilder den tatsächlichen Eingang von {0}. Die Kartenmarkierung bestätigt den Eingang nicht. Bestätige erst, wenn du angekommen bist.", .fr: "Cherchez l’entrée réelle de {0} à l’aide des panneaux. Le repère sur la carte ne confirme pas l’entrée. Confirmez seulement à votre arrivée."],
        .arrivedInstruction: [.en: "You confirmed your arrival. You can now plan your return journey.", .de: "Du hast deine Ankunft bestätigt. Du kannst jetzt die Rückreise planen.", .fr: "Vous avez confirmé votre arrivée. Vous pouvez maintenant préparer votre retour."],
        .roundTripInstruction: [.en: "You confirmed the end of your return journey.", .de: "Du hast das Ende deiner Rückreise bestätigt.", .fr: "Vous avez confirmé la fin de votre trajet retour."],
        .unknownInstruction: [.en: "Check your current stop and journey details before continuing. Update your progress only after checking where you are.", .de: "Prüfe vor dem Fortsetzen deine Haltestelle und die Reisedetails. Aktualisiere deinen Fortschritt erst, wenn du deinen Standort geprüft hast.", .fr: "Vérifiez votre arrêt et les détails du trajet avant de continuer. Mettez à jour votre progression seulement après avoir vérifié où vous êtes."],
        .start: [.en: "Start journey", .de: "Reise starten", .fr: "Commencer le trajet"],
        .returnJourney: [.en: "Plan the return journey", .de: "Rückreise planen", .fr: "Préparer le retour"],
        .roundTripComplete: [.en: "Round trip complete", .de: "Hin- und Rückreise abgeschlossen", .fr: "Aller-retour terminé"],
        .alighted: [.en: "I got off here", .de: "Ich bin hier ausgestiegen", .fr: "Je suis descendu ici"],
        .boarded: [.en: "I am on board", .de: "Ich bin eingestiegen", .fr: "Je suis à bord"],
        .atWaitingArea: [.en: "I am at the waiting area", .de: "Ich bin am Wartebereich", .fr: "Je suis dans la zone d’attente"],
        .arrived: [.en: "I have arrived", .de: "Ich bin angekommen", .fr: "Je suis arrivé"],
        .walkCompleted: [.en: "I completed this walk", .de: "Ich habe diesen Fussweg beendet", .fr: "J’ai terminé cette marche"],
        .yourService: [.en: "Your service", .de: "Deine Verbindung", .fr: "Votre service"],
        .beforeBoarding: [.en: "Before you board", .de: "Vor dem Einsteigen", .fr: "Avant de monter"],
        .unknownLine: [.en: "Unknown line", .de: "Linie unbekannt", .fr: "Ligne inconnue"],
        .unknownDestination: [.en: "Unknown destination", .de: "Fahrtziel unbekannt", .fr: "Destination inconnue"],
        .platform: [.en: "Platform", .de: "Gleis / Kante", .fr: "Voie / quai"],
        .notProvided: [.en: "Not provided", .de: "Nicht angegeben", .fr: "Non indiqué"],
        .waitingArea: [.en: "Waiting area", .de: "Wartebereich", .fr: "Zone d’attente"],
        .verifiedArea: [.en: "Verified area", .de: "Bestätigter Bereich", .fr: "Zone vérifiée"],
        .notVerified: [.en: "Not verified", .de: "Nicht bestätigt", .fr: "Non vérifié"],
        .stepFreeAccess: [.en: "Step-free access", .de: "Stufenloser Zugang", .fr: "Accès sans marches"],
        .reportedAvailable: [.en: "Reported available", .de: "Als verfügbar gemeldet", .fr: "Signalé comme disponible"],
        .notStepFree: [.en: "Not step-free", .de: "Nicht stufenlos", .fr: "Avec marches"],
        .unknown: [.en: "Unknown", .de: "Unbekannt", .fr: "Inconnu"],
        .boardingUnavailable: [.en: "Boarding is unavailable: this call is cancelled, skipped or prohibits pickup. Select another itinerary.", .de: "Einstieg nicht möglich: Dieser Halt entfällt, wird übersprungen oder erlaubt keinen Einstieg. Wähle eine andere Verbindung.", .fr: "Montée impossible : cet arrêt est annulé, non desservi ou interdit la montée. Choisissez un autre itinéraire."],
        .stopReference: [.en: "The stop reference is not a place to stand. Check local signs, the full destination display and safe pedestrian access.", .de: "Die Haltestellenreferenz ist kein bestätigter Standplatz. Prüfe die Schilder, das vollständige Fahrtziel am Fahrzeug und den sicheren Zugang zu Fuss.", .fr: "Le repère d’arrêt n’indique pas où se tenir. Vérifiez les panneaux, la destination complète du véhicule et l’accès piéton sûr."],
        .matching: [.en: "Service evidence matches. Passenger side is still unknown.", .de: "Die Hinweise passen zur Verbindung. Deine Strassenseite ist weiterhin unbekannt.", .fr: "Les indices correspondent au service. Votre côté de la rue reste inconnu."],
        .vehicleUnknown: [.en: "Cannot confirm this vehicle yet. Check its line and full destination before boarding.", .de: "Dieses Fahrzeug ist noch nicht bestätigt. Prüfe vor dem Einsteigen die Linie und das vollständige Fahrtziel.", .fr: "Ce véhicule n’est pas encore confirmé. Vérifiez sa ligne et sa destination complète avant de monter."],
        .wholeJourney: [.en: "Your whole journey", .de: "Deine ganze Reise", .fr: "Votre trajet complet"],
        .checkDestination: [.en: "Check destination", .de: "Fahrtziel prüfen", .fr: "Vérifiez la destination"],
        .walkConnection: [.en: "Walk to your connection", .de: "Zum Anschluss gehen", .fr: "Rejoindre la correspondance à pied"],
        .walk: [.en: "Walk", .de: "Zu Fuss", .fr: "À pied"],
        .pathUnverified: [.en: "Walking path and safe crossings are not verified.", .de: "Fussweg und sichere Übergänge sind nicht geprüft.", .fr: "Le chemin piéton et les passages sûrs ne sont pas vérifiés."],
        .predicted: [.en: "Predicted {0} · check source age", .de: "Prognose {0} · prüfe das Alter der Quelle", .fr: "Prévision {0} · vérifiez l’ancienneté de la source"],
        .updateProgress: [.en: "Update my progress to this leg", .de: "Meinen Fortschritt auf diesen Abschnitt setzen", .fr: "Mettre ma progression à cette étape"],
        .preferences: [.en: "Journey preferences", .de: "Reiseeinstellungen", .fr: "Préférences de trajet"],
        .preferStepFree: [.en: "Prefer step-free routes", .de: "Stufenlose Wege bevorzugen", .fr: "Privilégier les parcours sans marches"],
        .accessCaution: [.en: "The public provider cannot verify all lifts, entrances or step-free paths.", .de: "Der öffentliche Anbieter kann nicht alle Aufzüge, Eingänge und stufenlosen Wege prüfen.", .fr: "Le fournisseur public ne peut pas vérifier tous les ascenseurs, entrées et chemins sans marches."],
        .savedRecovery: [.en: "Saved recovery", .de: "Gespeicherte Reise fortsetzen", .fr: "Reprise du trajet enregistré"],
        .useOffline: [.en: "Use saved / offline guidance", .de: "Gespeicherte / Offline-Reisebegleitung nutzen", .fr: "Utiliser le guidage enregistré / hors ligne"],
        .openSaved: [.en: "Open saved journey", .de: "Gespeicherte Reise öffnen", .fr: "Ouvrir le trajet enregistré"],
        .savedCaution: [.en: "Your selected journey and progress are saved on this iPhone. Saved predictions retain their original ages.", .de: "Deine gewählte Reise und dein Fortschritt sind auf diesem iPhone gespeichert. Gespeicherte Prognosen behalten ihr ursprüngliches Alter.", .fr: "Votre trajet et votre progression sont enregistrés sur cet iPhone. Les prévisions enregistrées conservent leur ancienneté d’origine."],
        .currentLocation: [.en: "Current location", .de: "Aktueller Standort", .fr: "Position actuelle"],
        .about: [.en: "About this build", .de: "Über diese Version", .fr: "À propos de cette version"],
        .attribution: [.en: "Maps, places and walking directions by Apple Maps. Swiss public transport connections by transport.opendata.ch.", .de: "Karten, Orte und Fusswege von Apple Maps. Schweizer ÖV-Verbindungen von transport.opendata.ch.", .fr: "Cartes, lieux et itinéraires piétons : Apple Plans. Trajets en transports publics suisses : transport.opendata.ch."],
        .cameraCaution: [.en: "Camera evidence assists navigation; it may not confirm a vehicle, waiting area or passenger side. Geographic markers need supported coverage and reliable tracking. Location tracking stops in the background.", .de: "Kamerahinweise unterstützen die Navigation, bestätigen aber nicht immer Fahrzeug, Wartebereich oder Strassenseite. Geografische Marker benötigen unterstützte Abdeckung und zuverlässige Ortung. Im Hintergrund endet die Standortverfolgung.", .fr: "Les indices de la caméra aident au guidage sans toujours confirmer le véhicule, la zone d’attente ou votre côté de la rue. Les repères géographiques nécessitent une couverture adaptée et un suivi fiable. Le suivi de position s’arrête en arrière-plan."],
        .source: [.en: "Public transport source", .de: "Quelle für den öffentlichen Verkehr", .fr: "Source des transports publics"],
        .originalMessage: [.en: "Original message · {0}", .de: "Originalmeldung · {0}", .fr: "Message d’origine · {0}"],
        .translationScope: [.en: "Journey controls are translated. Map directions, camera and location messages, and provider details may remain in their original language.", .de: "Die Reisebedienung ist übersetzt. Kartenanweisungen, Kamera- und Standortmeldungen sowie Anbieterdetails können in ihrer Originalsprache bleiben.", .fr: "Les commandes du trajet sont traduites. Les instructions cartographiques, messages de caméra et de position, et détails du fournisseur peuvent rester dans leur langue d’origine."],
        .errorHelp: [.en: "Something needs attention. Check your connection or use saved guidance; review the original message below.", .de: "Etwas muss geprüft werden. Prüfe die Verbindung oder nutze die gespeicherte Reise; lies die Originalmeldung unten.", .fr: "Un problème nécessite votre attention. Vérifiez la connexion ou utilisez le guidage enregistré ; consultez le message d’origine ci-dessous."],
        .searching: [.en: "Searching…", .de: "Suche läuft…", .fr: "Recherche…"],
        .placesAddresses: [.en: "Places & addresses", .de: "Orte und Adressen", .fr: "Lieux et adresses"],
        .publicTransport: [.en: "Public transport", .de: "Öffentlicher Verkehr", .fr: "Transports publics"],
        .swissTransit: [.en: "Swiss public transport", .de: "Schweizer öffentlicher Verkehr", .fr: "Transports publics suisses"],
        .searchHint: [.en: "Search a place, address or station.", .de: "Suche einen Ort, eine Adresse oder eine Haltestelle.", .fr: "Cherchez un lieu, une adresse ou un arrêt."],
        .noPlaces: [.en: "No places found. Try adding a town.", .de: "Keine Orte gefunden. Ergänze den Ortsnamen.", .fr: "Aucun lieu trouvé. Ajoutez le nom d’une ville."],
        .searchPrompt: [.en: "Address, business, place or station", .de: "Adresse, Geschäft, Ort oder Haltestelle", .fr: "Adresse, commerce, lieu ou arrêt"],
        .placeSearchUnavailable: [.en: "Place search is unavailable. Station results may still be available; check your connection and try again.", .de: "Ortssuche nicht verfügbar. Haltestellen können weiterhin angezeigt werden; prüfe die Verbindung und versuche es erneut.", .fr: "La recherche de lieux est indisponible. Des arrêts peuvent encore s’afficher ; vérifiez la connexion et réessayez."],
        .searchUnavailable: [.en: "Search is unavailable. Check your connection and try again.", .de: "Suche nicht verfügbar. Prüfe die Verbindung und versuche es erneut.", .fr: "Recherche indisponible. Vérifiez la connexion et réessayez."],
        .stationSearchUnavailable: [.en: "Station search is unavailable. Places and addresses are shown.", .de: "Haltestellensuche nicht verfügbar. Orte und Adressen werden angezeigt.", .fr: "La recherche d’arrêts est indisponible. Les lieux et adresses sont affichés."],
        .cancel: [.en: "Cancel", .de: "Abbrechen", .fr: "Annuler"],
        .findingLocation: [.en: "Finding your location…", .de: "Standort wird ermittelt…", .fr: "Recherche de votre position…"],
        .useLocation: [.en: "Use my location", .de: "Meinen Standort verwenden", .fr: "Utiliser ma position"],
        .openSettings: [.en: "Open Settings", .de: "Einstellungen öffnen", .fr: "Ouvrir les réglages"],
        .locationHelp: [.en: "If location is unavailable, choose your starting point by searching. You can change location access in Settings.", .de: "Wenn dein Standort nicht verfügbar ist, suche deinen Startpunkt. Du kannst den Standortzugriff in den Einstellungen ändern.", .fr: "Si votre position est indisponible, recherchez votre point de départ. Vous pouvez modifier l’accès à la position dans les réglages."],
    ]
}

enum JourneyText: String, CaseIterable {
    case chooseBoth
    case noItineraries
    case demoScenario
    case liveCaution
    case demoLoaded
    case manualDemo
    case completeFirst
    case startFirst
    case resumed
    case noSaved
    case restoredDemo
    case restoredOffline
    case refreshUnavailable
    case cameraDemo
    case staleLocation
    case approximateLocation
    case chooseItinerary
    case savingFailed
    case restoreFailed

    case language
    case languageHelp
    case findingJourneys
    case journeys
    case from
    case startingPoint
    case demo
    case offline
    case camera
    case resume
    case back
    case startingFrom
    case goingTo
    case whereNow
    case done
    case journeyStop
    case referenceLocation
    case mappedWalk
    case details
    case changeJourney
    case map2D
    case map3D
    case switch2D
    case switch3D
    case wholeMap
    case replan
    case stopNext
    case nextSimulation
    case savedJourney
    case swap
    case tryDemo
    case settings
    case more
    case walkDirections
    case appleEstimate
    case mapCaution
    case correctLeg
    case approachingChoice
    case waitingChoice
    case ridingChoice
    case alightingChoice
    case walkingChoice
    case correctionCaution
    case arriveBy
    case departAt
    case arriveToggle
    case leaveNow
    case zurichTime
    case departure
    case whereTo
    case to
    case chooseStart
    case arriveTime
    case departTime
    case findJourneys
    case address
    case transit
    case direct
    case oneChange
    case changes
    case overview
    case arrivalConfirmed
    case step
    case platformValue
    case checkDepartures
    case unavailable
    case conflicting
    case waitingUnverified
    case walkMinutes
    case followSigns
    case walkUnavailable
    case replanWarning
    case nextDestination
    case complete
    case rideTitle
    case alightTitle
    case approachTitle
    case waitingTitle
    case walkTitle
    case transferTitle
    case finalWalkTitle
    case serviceFallback
    case destinationFallback
    case stopFallback
    case previewInstruction
    case walkInstruction
    case approachInstruction
    case waitingInstruction
    case ridingInstruction
    case alightingInstruction
    case transferInstruction
    case finalInstruction
    case arrivedInstruction
    case roundTripInstruction
    case unknownInstruction
    case start
    case returnJourney
    case roundTripComplete
    case alighted
    case boarded
    case atWaitingArea
    case arrived
    case walkCompleted
    case yourService
    case beforeBoarding
    case unknownLine
    case unknownDestination
    case platform
    case notProvided
    case waitingArea
    case verifiedArea
    case notVerified
    case stepFreeAccess
    case reportedAvailable
    case notStepFree
    case unknown
    case boardingUnavailable
    case stopReference
    case matching
    case vehicleUnknown
    case wholeJourney
    case checkDestination
    case walkConnection
    case walk
    case pathUnverified
    case predicted
    case updateProgress
    case preferences
    case preferStepFree
    case accessCaution
    case savedRecovery
    case useOffline
    case openSaved
    case savedCaution
    case currentLocation
    case about
    case attribution
    case cameraCaution
    case source
    case originalMessage
    case translationScope
    case errorHelp
    case searching
    case placesAddresses
    case publicTransport
    case swissTransit
    case searchHint
    case noPlaces
    case searchPrompt
    case placeSearchUnavailable
    case searchUnavailable
    case stationSearchUnavailable
    case cancel
    case findingLocation
    case useLocation
    case openSettings
    case locationHelp
}

/// Explicit passenger-confirmed phases; no clock or location inference here.
enum JourneyGuidancePhase: String, CaseIterable {
    case preview, walking, approaching, waiting, riding, alighting, transfer, finalWalk = "final_walk", arrived, unknown
    init(_ value: String?) { self = value == nil ? .preview : Self(rawValue: value!) ?? .unknown }
}

struct JourneyGuidance {
    let language: JourneyLanguage
    let phase: JourneyGuidancePhase
    let stop: String
    let destination: String
    let line: String
    let headsign: String
    var canReturn = true

    var title: String {
        switch phase {
        case .preview: destination
        case .walking: language.text(.walkTitle, destination)
        case .approaching: language.text(.approachTitle, stop)
        case .waiting: language.text(.waitingTitle, line, headsign)
        case .riding: language.text(.rideTitle, destination)
        case .alighting: language.text(.alightTitle, destination)
        case .transfer: language.text(.transferTitle, destination)
        case .finalWalk: language.text(.finalWalkTitle, destination)
        case .arrived: language.text(.complete)
        case .unknown: language.text(.details)
        }
    }
    var instruction: String {
        switch phase {
        case .preview: language.text(.previewInstruction)
        case .walking: language.text(.walkInstruction, destination)
        case .approaching: language.text(.approachInstruction, stop, line, headsign)
        case .waiting: language.text(.waitingInstruction, line, headsign)
        case .riding: language.text(.ridingInstruction, destination)
        case .alighting: language.text(.alightingInstruction, destination)
        case .transfer: language.text(.transferInstruction, destination)
        case .finalWalk: language.text(.finalInstruction, destination)
        case .arrived: language.text(canReturn ? .arrivedInstruction : .roundTripInstruction)
        case .unknown: language.text(.unknownInstruction)
        }
    }
    var action: String {
        language.text(actionKey)
    }
    var actionKey: JourneyText {
        switch phase {
        case .preview: .start
        case .walking, .transfer: .walkCompleted
        case .approaching: .atWaitingArea
        case .waiting: .boarded
        case .riding, .alighting: .alighted
        case .finalWalk: .arrived
        case .arrived: canReturn ? .returnJourney : .roundTripComplete
        case .unknown: .details
        }
    }
}

// The current Store exposes prose rather than typed notices. Translate only exact known
// app-owned messages; preserve unfamiliar/provider diagnostics without guessing meanings.
extension JourneyLanguage {
    func appMessage(_ message: String) -> String {
        if let key = Self.appMessageKeys[message] { return text(key) }
        let choose = "Choose an itinerary and start it to replace current guidance. "
        if message.hasPrefix(choose) {
            let detail = String(message.dropFirst(choose.count))
            return text(.chooseItinerary) + (detail.isEmpty ? "" : "\n" + text(.originalMessage, detail))
        }
        if message.hasPrefix("Guidance is active, but saving failed:") {
            return text(.savingFailed) + "\n" + text(.originalMessage, message)
        }
        if message.hasPrefix("Could not restore the saved journey:") {
            return text(.restoreFailed) + "\n" + text(.originalMessage, message)
        }
        return text(.originalMessage, message)
    }
    static let appMessageKeys: [String: JourneyText] = [
        "Select an origin and destination from the place suggestions.": .chooseBoth,
        "No validated itineraries returned. Current guidance is preserved.": .noItineraries,
        "Simulated Bern scenario. Times, geometry, platforms and events are invented.": .demoScenario,
        "Live source itinerary. Walking paths, waiting areas and exact trip refresh are unverified.": .liveCaution,
        "Simulated Bern demo loaded. Start it to begin the labelled scenario.": .demoLoaded,
        "Manual simulated journey. Reload the demo to use scripted events.": .manualDemo,
        "Complete the current journey before starting a return.": .completeFirst,
        "Start a journey before replanning.": .startFirst,
        "Resumed current journey.": .resumed,
        "No saved journey is available.": .noSaved,
        "Restored simulated scenario at its saved clock.": .restoredDemo,
        "Restored saved guidance offline. Original evidence ages are preserved; search again for current options.": .restoredOffline,
        "Exact trip refresh is unavailable: the community source has no authoritative trip occurrence ID. Replan from an explicitly selected current place.": .refreshUnavailable,
        "Native camera evidence is separate from the simulated scenario.": .cameraDemo,
        "Received an old or future location. Request again or select your current place manually.": .staleLocation,
        "Approximate location selected as the search origin. No street side, floor or waiting area is confirmed.": .approximateLocation,
    ]
}

// Existing EN/DE/FR coverage for departure exploration; physical labels remain values.
extension JourneyLanguage {
    static let departureCatalogue: [String: [String]] = [
        "Stop departures": ["Abfahrten an der Haltestelle", "Départs à l’arrêt"],
        "Departures": ["Abfahrten", "Départs"],
        "Done": ["Fertig", "Terminé"],
        "Cancel": ["Abbrechen", "Annuler"],
        "Saved stops": ["Gespeicherte Haltestellen", "Arrêts enregistrés"],
        "Choose a transit stop": ["Haltestelle wählen", "Choisir un arrêt"],
        "Plan to a destination": ["Reise zu einem Ziel planen", "Planifier vers une destination"],
        "Search for a transit stop": ["Haltestelle suchen", "Rechercher un arrêt"],
        "Choose destination": ["Ziel wählen", "Choisir la destination"],
        "No departures returned. Try another stop or refresh later.": ["Keine Abfahrten gefunden. Wähle eine andere Haltestelle oder aktualisiere später.", "Aucun départ reçu. Choisissez un autre arrêt ou actualisez plus tard."],
        "Check station displays before boarding. Cancellation status and exact trip binding are not supplied. Platforms are source labels, not verified waiting areas.": ["Prüfe vor dem Einsteigen die Anzeigen. Ausfälle und eine eindeutige Zuordnung zur Fahrt werden nicht geliefert. Gleis- und Haltekantenangaben sind Quellenangaben, keine geprüften Wartebereiche.", "Vérifiez les panneaux avant de monter. Les annulations et l’identification exacte de la course ne sont pas fournies. Les quais sont des indications de la source, pas des zones d’attente vérifiées."],
        "No saved departures for this stop within the last 24 hours.": ["Für diese Haltestelle sind keine Abfahrten aus den letzten 24 Stunden gespeichert.", "Aucun départ enregistré depuis moins de 24 heures pour cet arrêt."],
        "Choose a stop or refresh to load departures.": ["Wähle eine Haltestelle oder aktualisiere die Abfahrten.", "Choisissez un arrêt ou actualisez pour charger les départs."],
        "No saved stops from the last 24 hours. Reconnect to search for a transit stop.": ["Keine Haltestellen aus den letzten 24 Stunden gespeichert. Verbinde dich mit dem Internet, um zu suchen.", "Aucun arrêt enregistré depuis moins de 24 heures. Reconnectez-vous pour rechercher un arrêt."],
        "Use saved departures offline": ["Gespeicherte Abfahrten offline nutzen", "Utiliser les départs enregistrés hors ligne"],
        "Refresh departures": ["Abfahrten aktualisieren", "Actualiser les départs"],
        "Plan a fresh journey from this stop": ["Neue Reise ab dieser Haltestelle planen", "Planifier un nouveau trajet depuis cet arrêt"],
        "All times are Swiss time (Europe/Zurich); UTC offsets are shown.": ["Alle Zeiten gelten für die Schweiz (Europe/Zurich); die UTC-Abweichung wird angezeigt.", "Tous les horaires sont à l’heure suisse (Europe/Zurich) ; le décalage UTC est indiqué."],
        "Leave now": ["Jetzt abfahren", "Partir maintenant"],
        "Arrive by this time": ["Bis zu dieser Zeit ankommen", "Arriver avant cette heure"],
        "Planning time": ["Planungszeit", "Heure du trajet"],
        "A new full search may propose another service. Your active journey stays in place until you choose an alternative and tap Start.": ["Eine neue Suche kann eine andere Verbindung vorschlagen. Deine aktive Reise bleibt erhalten, bis du eine Alternative auswählst und Start tippst.", "Une nouvelle recherche peut proposer une autre liaison. Votre trajet actif reste inchangé jusqu’au choix d’une alternative et à l’action Démarrer."],
        "Planning…": ["Suche läuft…", "Recherche…"],
        "Find fresh journeys": ["Neue Verbindungen suchen", "Rechercher de nouveaux trajets"],
        "No journeys found. Change the destination or time and try again. Your current journey is unchanged.": ["Keine Verbindungen gefunden. Ändere Ziel oder Zeit und versuche es erneut. Deine aktuelle Reise bleibt unverändert.", "Aucun trajet trouvé. Modifiez la destination ou l’heure et réessayez. Votre trajet actuel reste inchangé."],
        "Planning failed. Your request is kept; try again.": ["Die Suche ist fehlgeschlagen. Deine Angaben bleiben erhalten; versuche es erneut.", "La recherche a échoué. Votre demande est conservée ; réessayez."],
        "Reconnect to request a fresh journey. Saved departure times cannot plan or refresh a trip.": ["Verbinde dich mit dem Internet, um neu zu planen. Gespeicherte Abfahrten können keine Reise planen oder aktualisieren.", "Reconnectez-vous pour planifier un trajet. Les horaires enregistrés ne permettent pas de calculer ou d’actualiser un trajet."],
        "Recently requested departures": ["Kürzlich abgefragte Abfahrten", "Départs récemment demandés"],
        "Saved departures · may be out of date": ["Gespeicherte Abfahrten · möglicherweise veraltet", "Départs enregistrés · peuvent être périmés"],
        "transport.opendata.ch · provider observation time unavailable": ["transport.opendata.ch · Beobachtungszeit der Quelle unbekannt", "transport.opendata.ch · heure d’observation de la source indisponible"],
        "Source details": ["Quellendetails", "Détails de la source"],
        "Response date is not an observation time. Predictions shown only for a successful request from this session within 90 seconds. Saved boards expire after 24 hours.": ["Das Antwortdatum ist keine Beobachtungszeit. Prognosen werden nur nach einer erfolgreichen Abfrage in dieser Sitzung für 90 Sekunden angezeigt. Gespeicherte Abfahrtstafeln verfallen nach 24 Stunden.", "La date de réponse n’est pas une heure d’observation. Les prévisions sont affichées pendant 90 secondes après une requête réussie dans cette session. Les tableaux enregistrés expirent après 24 heures."],
        "Destination not supplied": ["Ziel nicht geliefert", "Destination non fournie"],
        "destination not supplied": ["Ziel nicht geliefert", "destination non fournie"],
        "not supplied": ["nicht geliefert", "non fourni"],
        "Current prediction unavailable": ["Aktuelle Prognose nicht verfügbar", "Prévision actuelle indisponible"],
        "Scheduled time has passed": ["Die geplante Zeit ist vorbei", "L’heure prévue est passée"],
        "Reported service": ["Gemeldete Verbindung", "Service indiqué"],
        "Cancellation status not supplied": ["Ausfallstatus nicht geliefert", "État d’annulation non fourni"],
        "Reported calls · choose a planning destination": ["Gemeldete Halte · Ziel für die Planung wählen", "Arrêts indiqués · choisir une destination"],
        "Call details not supplied. Choose a destination using search.": ["Haltedetails nicht geliefert. Wähle ein Ziel über die Suche.", "Détails des arrêts non fournis. Choisissez une destination avec la recherche."],
        "Call order is reported by the source. Selecting a stop starts an editable full-plan request, not a booking or guarantee of this service.": ["Die Haltereihenfolge stammt aus der Quelle. Die Auswahl eines Halts bereitet eine bearbeitbare Reiseanfrage vor, keine Buchung oder Garantie dieser Verbindung.", "L’ordre des arrêts provient de la source. Choisir un arrêt prépare une demande de trajet modifiable, sans réservation ni garantie de ce service."],
        "Explore stops and departures": ["Haltestellen und Abfahrten ansehen", "Explorer les arrêts et départs"],
        "Stops and departures": ["Haltestellen und Abfahrten", "Arrêts et départs"],
        "Service": ["Verbindung", "Service"],
        "Map reference for {0}, not your location": ["Kartenreferenz für {0}, nicht dein Standort", "Repère cartographique de {0}, pas votre position"],
        "Saved: {0}": ["Gespeichert: {0}", "Enregistré : {0}"],
        "Explored: {0}": ["Angesehen: {0}", "Consulté : {0}"],
        "Use current journey destination: {0}": ["Aktuelles Reiseziel verwenden: {0}", "Utiliser la destination actuelle : {0}"],
        "Plan back to: {0}": ["Rückreise nach: {0}", "Retour vers : {0}"],
        "Retrieved {0}": ["Abgerufen: {0}", "Reçu le {0}"],
        "{0} additional or invalid rows omitted.": ["{0} weitere oder ungültige Zeilen ausgelassen.", "{0} lignes supplémentaires ou invalides omises."],
        "Stop ID {0} · upcoming departures": ["Haltestellen-ID {0} · nächste Abfahrten", "Identifiant d’arrêt {0} · prochains départs"],
        "HTTP response date: {0}": ["HTTP-Antwortdatum: {0}", "Date de réponse HTTP : {0}"],
        "Scheduled {0}": ["Fahrplan: {0}", "Horaire prévu : {0}"],
        "Reported prediction {0}": ["Gemeldete Prognose: {0}", "Prévision indiquée : {0}"],
        "Timetable platform {0} · check signs": ["Gleis/Haltekante laut Fahrplan: {0} · Anzeigen prüfen", "Quai prévu : {0} · vérifiez les panneaux"],
        "Reported platform prediction {0}": ["Prognose für Gleis/Haltekante: {0}", "Prévision de quai indiquée : {0}"],
        "Platform label: {0}": ["Gleis-/Haltekantenangabe: {0}", "Indication de quai : {0}"],
        "Operator: {0}": ["Betreiber: {0}", "Exploitant : {0}"],
        "Service reference: {0}. This is not a verified trip occurrence.": ["Verbindungsreferenz: {0}. Dies ist keine bestätigte Fahrtkennung.", "Référence du service : {0}. Ce n’est pas une course identifiée de façon vérifiée."],
        "Timetable {0}": ["Fahrplan: {0}", "Horaire : {0}"],
        "Plan a fresh journey to {0}": ["Neue Reise nach {0} planen", "Planifier un nouveau trajet vers {0}"],
        "Departures: {0}": ["Abfahrten: {0}", "Départs : {0}"],
        "This place has no unambiguous provider stop ID. Choose a transit stop from search.": ["Dieser Ort hat keine eindeutige Haltestellen-ID der Quelle. Wähle eine Haltestelle aus der Suche.", "Ce lieu n’a pas d’identifiant d’arrêt univoque. Choisissez un arrêt dans la recherche."],
        "Departure source returned an invalid or expired snapshot.": ["Die Abfahrtsquelle hat ungültige oder veraltete Daten geliefert.", "La source des départs a renvoyé des données invalides ou périmées."],
        "Departures loaded, but could not be saved for offline use.": ["Abfahrten geladen, konnten aber nicht offline gespeichert werden.", "Départs chargés, mais leur enregistrement hors ligne a échoué."],
        "Select an identified transit stop.": ["Wähle eine identifizierte Haltestelle.", "Choisissez un arrêt identifié."],
        "Departure source requested a pause. Please try later.": ["Die Abfahrtsquelle verlangt eine Pause. Versuche es später erneut.", "La source demande une pause. Réessayez plus tard."],
        "Departure source unavailable.": ["Abfahrtsquelle nicht verfügbar.", "Source des départs indisponible."],
        "Departure source is busy. Try again after its requested pause.": ["Die Abfahrtsquelle ist ausgelastet. Versuche es nach der angeforderten Pause erneut.", "La source est occupée. Réessayez après la pause demandée."],
        "Departure source unavailable. Saved times may still be inspected.": ["Abfahrtsquelle nicht verfügbar. Gespeicherte Zeiten bleiben einsehbar.", "Source indisponible. Les horaires enregistrés restent consultables."],
        "Departure response exceeds the local size limit.": ["Die Abfahrtsantwort überschreitet die lokale Grössenbegrenzung.", "La réponse des départs dépasse la limite de taille locale."],
        "Invalid stop or oversized departure response.": ["Ungültige Haltestelle oder zu grosse Abfahrtsantwort.", "Arrêt invalide ou réponse des départs trop volumineuse."],
        "Departure source returned a different or unidentified stop.": ["Die Abfahrtsquelle hat eine andere oder nicht identifizierte Haltestelle geliefert.", "La source a renvoyé un autre arrêt ou un arrêt non identifié."],
        "Departure snapshot has invalid or expired dates.": ["Die Abfahrtsdaten enthalten ungültige oder veraltete Zeitangaben.", "Les dates des départs sont invalides ou périmées."],
        "Departure rows have no valid stop or scheduled time.": ["Die Abfahrtszeilen haben keine gültige Haltestelle oder Fahrplanzeit.", "Les départs n’ont pas d’arrêt ou d’horaire valide."],
        "Select an identified transit stop and a valid planning time.": ["Wähle eine identifizierte Haltestelle und eine gültige Planungszeit.", "Choisissez un arrêt identifié et une heure valide."],
    ]
    func departure(_ key: String, _ values: String...) -> String { departureRender(key, values: values) }
    func departureRender(_ key: String, values: [String]) -> String {
        let alternatives = Self.departureCatalogue[key]
        let template = self == .en ? key : alternatives?[self == .de ? 0 : 1] ?? key
        var result = "", index = template.startIndex
        while index < template.endIndex {
            if template[index] == "{", let end = template[index...].firstIndex(of: "}"),
               let number = Int(template[template.index(after: index)..<end]), values.indices.contains(number) {
                result += values[number]; index = template.index(after: end)
            } else { result.append(template[index]); index = template.index(after: index) }
        }
        return result
    }
    func departureMessage(_ message: String) -> String {
        Self.departureCatalogue[message] != nil ? departure(message) : appMessage(message)
    }
}

extension JourneyLanguage {
    /// A5 controls only; original stop, line, quay and destination labels are never keys.
    func service(_ key: String) -> String {
        let values: [String: [String]] = [
            "Service information": ["Serviceinformationen", "Informations du service"],
            "Planning source": ["Quelle für neue Planung", "Source des nouvelles recherches"],
            "Community planner": ["Community-Fahrplan", "Planificateur communautaire"],
            "OJP with service information": ["OJP mit Serviceinformationen", "OJP avec informations du service"],
            "Applies to new searches. Existing journeys keep their original source.": ["Gilt für neue Suchen. Bestehende Reisen behalten ihre Quelle.", "S’applique aux nouvelles recherches. Les trajets existants conservent leur source."],
            "Service information is source-reported. Response time is not a vehicle observation, passenger position or verified waiting area.": ["Informationen laut Quelle. Antwortzeit ist keine Fahrzeugbeobachtung, Fahrgastposition oder bestätigter Wartebereich.", "Informations fournies par la source. L’heure de réponse n’est ni une observation du véhicule, ni une position du voyageur, ni une zone d’attente vérifiée."],
            "Update all services": ["Alle Verbindungen aktualisieren", "Actualiser tous les services"],
            "Checking original service references…": ["Ursprüngliche Fahrtkennungen prüfen…", "Vérification des références originales…"],
            "This journey has no compatible service references. Plan a new OJP journey to use this feature.": ["Diese Reise hat keine kompatiblen Fahrtkennungen. Plane dafür eine neue OJP-Reise.", "Ce trajet n’a pas de références compatibles. Planifiez un nouveau trajet OJP pour utiliser cette fonction."],
            "Offline: saved information only. Source dates are unchanged.": ["Offline: nur gespeicherte Informationen. Quelldaten bleiben unverändert.", "Hors ligne : informations enregistrées uniquement. Les dates sources restent inchangées."],
            "Update failed; guidance preserved": ["Aktualisierung fehlgeschlagen; Reise bleibt erhalten", "Échec de l’actualisation ; guidage conservé"],
            "Plan fresh recovery": ["Neue Weiterreise planen", "Planifier une nouvelle continuation"],
            "Last received update": ["Zuletzt empfangene Aktualisierung", "Dernière actualisation reçue"],
            "Service changed. Replan before boarding.": ["Verbindung geändert. Vor dem Einstieg neu planen.", "Service modifié. Replanifiez avant de monter."],
            "No service inspection saved yet.": ["Noch keine Serviceprüfung gespeichert.", "Aucune consultation du service enregistrée."],
            "Selected calls matched by stop reference and timetable.": ["Gewählte Halte anhand Kennung und Fahrplan zugeordnet.", "Arrêts sélectionnés associés par référence et horaire."],
            "Recent source response": ["Kürzlich erzeugte Quellantwort", "Réponse source récente"],
            "Saved response; request a new update": ["Gespeicherte Antwort; bitte neu aktualisieren", "Réponse enregistrée ; demandez une actualisation"],
            "Response generated": ["Antwort erzeugt", "Réponse générée"], "Received": ["Empfangen", "Reçu"],
            "Provider reports cancellation": ["Quelle meldet Ausfall", "Annulation signalée par la source"],
            "Provider reports service not cancelled": ["Quelle meldet keinen Ausfall", "Service signalé non annulé par la source"],
            "Stop not served": ["Halt wird nicht bedient", "Arrêt non desservi"],
            "Boarding not permitted": ["Einstieg nicht erlaubt", "Montée non autorisée"],
            "Alighting not permitted": ["Ausstieg nicht erlaubt", "Descente non autorisée"],
            "Cancellation status not supplied": ["Ausfallstatus nicht geliefert", "Statut d’annulation non fourni"],
            "Changes and source details": ["Änderungen und Quelldetails", "Modifications et détails de la source"],
            "All service calls": ["Alle Halte der Fahrt", "Tous les arrêts du service"],
            "Timetable": ["Fahrplan", "Horaire"], "Supplied estimate": ["Gelieferte Prognose", "Estimation fournie"],
            "Platform label": ["Gleis-/Kantenbezeichnung", "Libellé du quai"],
            "Stop restriction reported; check service details": ["Haltbeschränkung gemeldet; Details prüfen", "Restriction d’arrêt signalée ; consultez les détails"]
        ]
        guard self != .en, let row = values[key] else { return key }
        return row[self == .de ? 0 : 1]
    }
}
