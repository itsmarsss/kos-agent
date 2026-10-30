import AppKit
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
/// It answers the pointer: lighter under it, a touch smaller pressed.
public struct KOSButtonStyle: ButtonStyle {
  public enum Kind { case primary, secondary, ghost, danger }

  private let kind: Kind

  public init(_ kind: Kind = .secondary) {
    self.kind = kind
  }

  public func makeBody(configuration: Configuration) -> some View {
    StyledButton(kind: kind, configuration: configuration)
  }

  private struct StyledButton: View {
    let kind: Kind
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
      let lit = hovering && enabled
      configuration.label
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(foreground(lit))
        .padding(.horizontal, 12)
        .padding(.vertical, 6.5)
        .background(background(lit: lit, pressed: configuration.isPressed), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(border(lit)))
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .opacity(enabled ? 1 : 0.45)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .pointingHand(enabled)
        .animation(.easeOut(duration: 0.14), value: lit)
        .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }

    private func foreground(_ lit: Bool) -> Color {
      switch kind {
      case .primary: return Theme.onAccent
      case .secondary: return Theme.text
      case .ghost: return lit ? Theme.text : Theme.muted
      case .danger: return Theme.danger
      }
    }

    private func background(lit: Bool, pressed: Bool) -> Color {
      switch kind {
      case .primary: return pressed ? Theme.accent.opacity(0.8) : lit ? Theme.accentLit : Theme.accent
      case .secondary: return pressed ? Theme.line : lit ? Theme.line.opacity(0.7) : Theme.panel2
      case .ghost: return pressed ? Theme.line : lit ? Theme.panel2 : .clear
      case .danger: return pressed ? Theme.danger.opacity(0.24) : lit ? Theme.danger.opacity(0.17) : Theme.danger.opacity(0.1)
      }
    }

    private func border(_ lit: Bool) -> Color {
      switch kind {
      case .primary: return .clear
      case .secondary: return lit ? Theme.lineStrong : Theme.line
      case .ghost: return .clear
      case .danger: return Theme.danger.opacity(lit ? 0.45 : 0.25)
      }
    }
  }
}

/// A link: KOS's blue, underlined under the pointer, with an arrow that says it leaves the app.
public struct KOSLink: View {
  private let title: String
  private let url: URL
  private let size: CGFloat
  @Environment(\.openURL) private var open
  @State private var hovering = false

  public init(_ title: String, to url: URL, size: CGFloat = 12) {
    self.title = title
    self.url = url
    self.size = size
  }

  public var body: some View {
    Button {
      open(url)
    } label: {
      HStack(spacing: 3) {
        Text(title).underline(hovering)
        Image(systemName: "arrow.up.right")
          .font(.system(size: size * 0.72, weight: .bold))
          .offset(x: hovering ? 1.5 : 0, y: hovering ? -1.5 : 0)
      }
      .font(.system(size: size, weight: .medium))
      .foregroundStyle(hovering ? Theme.accentLit : Theme.accent)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(.easeOut(duration: 0.14), value: hovering)
    .help(url.absoluteString)
  }
}

extension View {
  /// The pointing hand over something clickable, balanced however the pointer leaves.
  public func pointingHand(_ on: Bool = true) -> some View {
    modifier(PointingHand(on: on))
  }
}

private struct PointingHand: ViewModifier {
  let on: Bool
  @State private var pushed = false

  func body(content: Content) -> some View {
    content
      .onHover { inside in
        if inside && on && !pushed {
          NSCursor.pointingHand.push()
          pushed = true
        } else if !inside && pushed {
          NSCursor.pop()
          pushed = false
        }
      }
      .onDisappear {
        if pushed {
          NSCursor.pop()
          pushed = false
        }
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

  @State private var hovering = false

  public var body: some View {
    Button {
      set(!isOn)
    } label: {
      Capsule()
        .fill(isOn ? (hovering ? Theme.accentLit : Theme.accent) : (hovering ? Theme.faint : Theme.lineStrong))
        .frame(width: 34, height: 20)
        .overlay(alignment: isOn ? .trailing : .leading) {
          Circle().fill(isOn ? Theme.onAccent : Theme.text).frame(width: 14, height: 14).padding(3)
        }
        .animation(.easeOut(duration: 0.15), value: isOn)
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .accessibilityAddTraits(.isToggle)
    .accessibilityValue(isOn ? "On" : "Off")
  }
}
