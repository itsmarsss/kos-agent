import SwiftUI

/// The few controls every window here is made of, drawn in KOS's own style
/// rather than the system's grey, so they match the dashboard.

/// A group on a panel, like a card on the dashboard.
public struct Card<Content: View>: View {
  private let content: Content

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 10) { content }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line))
  }
}

/// A small heading over a card.
public struct SectionLabel: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text.uppercased())
      .font(.system(size: 10.5, weight: .semibold))
      .tracking(0.8)
      .foregroundStyle(Theme.faint)
  }
}

/// A state in a word, coloured by what it means.
public struct Pill: View {
  public enum Tone { case ok, warn, danger, accent, muted }

  private let text: String
  private let tone: Tone
  private let dot: Bool

  public init(_ text: String, tone: Tone, dot: Bool = false) {
    self.text = text
    self.tone = tone
    self.dot = dot
  }

  private var colour: Color {
    switch tone {
    case .ok: return Theme.ok
    case .warn: return Theme.warn
    case .danger: return Theme.danger
    case .accent: return Theme.accent
    case .muted: return Theme.muted
    }
  }

  public var body: some View {
    HStack(spacing: 5) {
      if dot { Circle().fill(colour).frame(width: 6, height: 6) }
      Text(text).font(.system(size: 11, weight: .medium))
    }
    .foregroundStyle(colour)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(colour.opacity(0.13), in: Capsule())
  }
}

/// A button: the one thing to do, a quieter one beside it, or one that removes.
public struct KOSButtonStyle: ButtonStyle {
  public enum Kind { case primary, secondary, ghost, danger }

  private let kind: Kind
  @Environment(\.isEnabled) private var enabled

  public init(_ kind: Kind = .secondary) {
    self.kind = kind
  }

  public func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12.5, weight: .semibold))
      .foregroundStyle(foreground)
      .padding(.horizontal, 12)
      .padding(.vertical, 6.5)
      .background(background(pressed: configuration.isPressed), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(border))
      .opacity(enabled ? 1 : 0.45)
      .contentShape(Rectangle())
  }

  private var foreground: Color {
    switch kind {
    case .primary: return Theme.onAccent
    case .secondary: return Theme.text
    case .ghost: return Theme.muted
    case .danger: return Theme.danger
    }
  }

  private func background(pressed: Bool) -> Color {
    switch kind {
    case .primary: return pressed ? Theme.accent.opacity(0.8) : Theme.accent
    case .secondary: return pressed ? Theme.line : Theme.panel2
    case .ghost: return pressed ? Theme.panel2 : .clear
    case .danger: return pressed ? Theme.danger.opacity(0.2) : Theme.danger.opacity(0.1)
    }
  }

  private var border: Color {
    switch kind {
    case .primary: return .clear
    case .secondary: return Theme.line
    case .ghost: return .clear
    case .danger: return Theme.danger.opacity(0.25)
    }
  }
}

/// A text field on a dark well, with its label above it.
public struct KOSField: View {
  private let label: String
  private let placeholder: String
  @Binding private var text: String
  private let mono: Bool

  public init(_ label: String, placeholder: String, text: Binding<String>, mono: Bool = false) {
    self.label = label
    self.placeholder = placeholder
    _text = text
    self.mono = mono
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.muted)
      TextField("", text: $text, prompt: Text(placeholder).foregroundColor(Theme.faint))
        .textFieldStyle(.plain)
        .font(mono ? .system(size: 13, design: .monospaced) : .system(size: 13))
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Theme.line))
    }
  }
}

/// An on/off switch in KOS's colours.
public struct KOSSwitch: View {
  private let isOn: Bool
  private let set: (Bool) -> Void

  public init(isOn: Bool, set: @escaping (Bool) -> Void) {
    self.isOn = isOn
    self.set = set
  }

  public var body: some View {
    Button {
      set(!isOn)
    } label: {
      Capsule()
        .fill(isOn ? Theme.accent : Theme.lineStrong)
        .frame(width: 34, height: 20)
        .overlay(alignment: isOn ? .trailing : .leading) {
          Circle().fill(isOn ? Theme.onAccent : Theme.text).frame(width: 14, height: 14).padding(3)
        }
        .animation(.easeOut(duration: 0.15), value: isOn)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(.isToggle)
    .accessibilityValue(isOn ? "On" : "Off")
  }
}
