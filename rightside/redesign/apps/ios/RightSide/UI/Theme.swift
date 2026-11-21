import SwiftUI

extension Color {
    static let rightSideTeal = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0.35, green: 0.89, blue: 0.56, alpha: 1) : UIColor(red: 0.02, green: 0.38, blue: 0.19, alpha: 1)
    })
    static let rightSideWarning = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 1, green: 0.72, blue: 0.35, alpha: 1) : UIColor(red: 0.50, green: 0.25, blue: 0.02, alpha: 1)
    })
    static let rightSidePaper = Color(uiColor: .systemGroupedBackground)
}

struct JourneyNotice: View {
    let text: String
    var warning = false
    var body: some View {
        Label(text, systemImage: warning ? "exclamationmark.triangle" : "info.circle")
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(warning ? Color.orange.opacity(0.13) : Color.rightSideTeal.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .combine)
    }
}

@MainActor
private enum JourneyTimeFormat {
    static let clock: DateFormatter = {
        let value = DateFormatter()
        value.timeZone = TimeZone(identifier: "Europe/Zurich")
        value.locale = Locale(identifier: "en_US_POSIX")
        value.dateFormat = "HH:mm"
        return value
    }()
}

@MainActor
func journeyTime(_ value: String?) -> String {
    guard let value, let date = WireClock.date(value) else { return "—" }
    return JourneyTimeFormat.clock.string(from: date)
}

func legSymbol(_ leg: Leg) -> String {
    guard leg.kind == "ride" else { return "figure.walk" }
    switch leg.mode {
    case "train": return "tram.fill"
    case "tram": return "tram"
    case "boat": return "ferry.fill"
    case "cableway": return "cablecar.fill"
    default: return "bus.fill"
    }
}

// App route colors distinguish modes; these are not agency-supplied line colors.
func routeColor(_ mode: String?) -> Color {
    switch mode {
    case "train": return Color(red: 0.65, green: 0.12, blue: 0.20)
    case "tram": return Color(red: 0.22, green: 0.24, blue: 0.65)
    case "boat": return Color(red: 0.04, green: 0.36, blue: 0.59)
    default: return Color(red: 0.04, green: 0.38, blue: 0.25)
    }
}

struct RouteBadge: View {
    let line: String
    var mode: String? = nil
    var body: some View {
        Text(line).font(.headline.weight(.heavy)).fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .foregroundStyle(.white).background(routeColor(mode), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TravelButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(enabled ? Color.white : Color(uiColor: .secondaryLabel))
            .background(enabled ? Color(red: 0.02, green: 0.38, blue: 0.19) : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
