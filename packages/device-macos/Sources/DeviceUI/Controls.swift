import AppKit
import SwiftUI

/// The few controls every window here is made of, drawn in KOS's own style
/// rather than the system's grey, so they match the dashboard. A window
/// builds from these; one that draws its own copy of one drifts from it.

/// A group on a panel, like a card on the dashboard. `tone` edges it in a
/// colour (an ask is the warn's), `wash` fills it with that colour's faint
/// tint instead of the panel (a quote, a notice).
public struct Card<Content: View>: View {
  private let tone: Color?
  private let wash: Bool
  private let padding: EdgeInsets
  private let content: Content

  public init(tone: Color? = nil, wash: Bool = false, padding: EdgeInsets = EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14), @ViewBuilder content: () -> Content) {
    self.tone = tone
    self.wash = wash
    self.padding = padding
    self.content = content()
  }

  public var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous)
    VStack(alignment: .leading, spacing: 10) { content }
      .padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(wash ? (tone ?? Theme.accent).opacity(0.08) : Theme.panel, in: shape)
      .overlay(shape.strokeBorder(tone.map { $0.opacity(wash ? 0.25 : Theme.edge).blended(over: Theme.line) } ?? Theme.line))
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
      .font(.kos(.tiny, .semibold))
      .tracking(0.8)
      .foregroundStyle(Theme.faint)
  }
}

/// A group of a page: its label, what it may do on the right, and its cards under them.
public struct KOSSection<Content: View, Trailing: View>: View {
  private let title: String
  private let trailing: Trailing
  private let content: Content

  public init(_ title: String, @ViewBuilder trailing: () -> Trailing, @ViewBuilder content: () -> Content) {
    self.title = title
    self.trailing = trailing()
    self.content = content()
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        SectionLabel(title)
        Spacer()
        trailing
      }
      content
    }
  }
}

extension KOSSection where Trailing == EmptyView {
  public init(_ title: String, @ViewBuilder content: () -> Content) {
    self.init(title, trailing: { EmptyView() }, content: content)
  }
}

/// A row's words: its title, and the line of detail under it.
public struct RowText: View {
  private let title: String
  private let detail: String?
  private let size: KOSType
  private let titleLines: Int?
  private let detailLines: Int?
  private let cut: Text.TruncationMode

  /// `size` is the title's; `cut` is where a title too long for the row is cut (the middle, for an address).
  public init(_ title: String, _ detail: String? = nil, size: KOSType = .dense, titleLines: Int? = nil, detailLines: Int? = nil, cut: Text.TruncationMode = .tail) {
    self.title = title
    self.detail = detail
    self.size = size
    self.titleLines = titleLines
    self.detailLines = detailLines
    self.cut = cut
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.kos(size, .semibold)).foregroundStyle(Theme.text).lineLimit(titleLines).truncationMode(cut)
      if let detail {
        Text(detail).font(.kos(.small)).foregroundStyle(Theme.muted).lineLimit(detailLines)
          .fixedSize(horizontal: false, vertical: detailLines == 1 ? false : true)
      }
    }
  }
}

/// A setting that is on or off: what it is, what it does now, and its switch.
public struct SwitchRow: View {
  private let title: String
  private let detail: String
  private let isOn: Bool
  private let set: (Bool) -> Void

  public init(_ title: String, _ detail: String, isOn: Bool, set: @escaping (Bool) -> Void) {
    self.title = title
    self.detail = detail
    self.isOn = isOn
    self.set = set
  }

  public var body: some View {
    HStack(alignment: .top, spacing: 12) {
      RowText(title, detail)
      Spacer(minLength: 8)
      KOSSwitch(isOn: isOn, set: set)
    }
  }
}

/// A symbol on its own tint: what a row is about, at a glance. `small` for a line inside something else, as the tab card's is.
public struct Tile: View {
  private let symbol: String
  private let tint: Color
  private let small: Bool

  public init(_ symbol: String, tint: Color, small: Bool = false) {
    self.symbol = symbol
    self.tint = tint
    self.small = small
  }

  public var body: some View {
    Image(systemName: symbol)
      .font(.system(size: small ? 12 : 14, weight: .medium))
      .foregroundStyle(tint)
      .frame(width: small ? 26 : 32, height: small ? 26 : 32)
      .background(tint.opacity(Theme.tint), in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
  }
}

/// A round mark of a state: live, paused, waiting.
public struct Dot: View {
  private let colour: Color
  private let size: CGFloat

  public init(_ colour: Color, size: CGFloat = 6) {
    self.colour = colour
    self.size = size
  }

  public var body: some View {
    Circle().fill(colour).frame(width: size, height: size)
  }
}

/// The one-point line between rows and under a header.
public struct Hairline: View {
  public init() {}

  public var body: some View {
    Rectangle().fill(Theme.line).frame(height: 1)
  }
}

/// A round button holding one symbol: the gear, the way back, close and minimise, a new chat.
public struct IconButton: View {
  private let symbol: String
  private let label: String
  /// The colour it takes under the pointer, for one that does something final, like Close.
  private let tint: Color?
  private let action: () -> Void
  @State private var hovering = false

  public init(symbol: String, label: String, tint: Color? = nil, action: @escaping () -> Void) {
    self.symbol = symbol
    self.label = label
    self.tint = tint
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(hovering ? (tint ?? Theme.text) : Theme.muted)
        .frame(width: 26, height: 26)
        .background(hovering ? (tint?.opacity(Theme.tint) ?? Theme.panel2) : .clear, in: Circle())
        .overlay(Circle().strokeBorder(hovering ? (tint?.opacity(Theme.edge) ?? Theme.line) : .clear))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(Theme.hover, value: hovering)
    .accessibilityLabel(label)
    .help(label)
  }
}

extension View {
  /// The dashboard's chip: 12 in the muted grey on a capsule of panel-2 with no edge, 24 high; the accent's tint
  /// when lit. One that can be pressed lightens under the pointer, as the panel's do.
  public func chip(lit: Bool = false, pressable: Bool = true) -> some View {
    modifier(ChipLook(lit: lit, pressable: pressable))
  }
}

private struct ChipLook: ViewModifier {
  let lit: Bool
  let pressable: Bool
  @State private var hovering = false

  func body(content: Content) -> some View {
    let lifted = hovering && pressable
    content
      .font(.kos(.detail))
      .foregroundStyle(lit ? Theme.accent : lifted ? Theme.text : Theme.muted)
      .padding(.horizontal, 10)
      .frame(minHeight: 24)
      .background(Capsule().fill(lit ? Theme.accent.opacity(Theme.tint).blended(over: Theme.panel) : lifted ? Theme.line : Theme.panel2))
      .contentShape(Capsule())
      .onHover { hovering = $0 }
      .pointingHand(pressable)
      .animation(Theme.hover, value: lifted)
  }
}

/// A chip of a symbol and a word or two, cut at its end when there is no room.
public struct Chip: View {
  private let symbol: String?
  private let text: String
  private let lit: Bool
  private let pressable: Bool

  public init(_ text: String, symbol: String? = nil, lit: Bool = false, pressable: Bool = true) {
    self.text = text
    self.symbol = symbol
    self.lit = lit
    self.pressable = pressable
  }

  public var body: some View {
    HStack(spacing: 4) {
      if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
      Text(text).lineLimit(1).truncationMode(.tail)
    }
    .chip(lit: lit, pressable: pressable)
  }
}

/// A row of a menu the window draws itself (the chats, the apps to hide):
/// lighter under the pointer, the current one on the accent's tint. `lit`
/// is what the pointer lights it with; the content is told when it is under it.
public struct MenuRow<Content: View>: View {
  private let on: Bool
  private let lit: Color
  private let height: CGFloat
  private let action: () -> Void
  private let content: (Bool) -> Content
  @State private var hovering = false

  public init(on: Bool = false, lit: Color = Theme.panel2, height: CGFloat = 30, action: @escaping () -> Void, @ViewBuilder content: @escaping (_ hovering: Bool) -> Content) {
    self.on = on
    self.lit = lit
    self.height = height
    self.action = action
    self.content = content
  }

  public var body: some View {
    Button(action: action) {
      content(hovering)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
        .foregroundStyle(on ? Theme.accent : Theme.text)
        .background(on ? Theme.accent.opacity(Theme.tint) : hovering ? lit : .clear, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(Theme.hover, value: hovering)
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
      if dot { Dot(colour) }
      Text(text).font(.kos(.tiny, .medium)).lineLimit(1)
    }
    .foregroundStyle(colour)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(colour.opacity(Theme.tint), in: Capsule())
    .fixedSize()
  }
}

/// A button: the one thing to do, a quieter one beside it, or one that removes.
/// It answers the pointer: lighter under it, a touch smaller pressed.
public struct KOSButtonStyle: ButtonStyle {
  public enum Kind { case primary, secondary, ghost, danger }

  private let kind: Kind
  private let capsule: Bool
  private let small: Bool

  /// `capsule` for a button inside something round, such as the session bar, whose corners a small radius would fight;
  /// `small` for one among words, as the extension's .btn--sm is.
  public init(_ kind: Kind = .secondary, capsule: Bool = false, small: Bool = false) {
    self.kind = kind
    self.capsule = capsule
    self.small = small
  }

  public func makeBody(configuration: Configuration) -> some View {
    StyledButton(kind: kind, radius: capsule ? 999 : Theme.radiusSm, small: small, configuration: configuration)
  }

  private struct StyledButton: View {
    let kind: Kind
    let radius: CGFloat
    let small: Bool
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
      let lit = hovering && enabled
      configuration.label
        .font(.kos(small ? .detail : .control, .semibold))
        .foregroundStyle(foreground(lit))
        .padding(.horizontal, small ? 8 : 12)
        .padding(.vertical, small ? 3 : 6.5)
        .background(background(lit: lit, pressed: configuration.isPressed), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(border(lit)))
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .opacity(enabled ? 1 : 0.45)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .pointingHand(enabled)
        .animation(Theme.hover, value: lit)
        .animation(Theme.press, value: configuration.isPressed)
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
      case .danger: return Theme.danger.opacity(lit ? Theme.edge : 0.25)
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
    .animation(Theme.hover, value: hovering)
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

/// One choice of a few, as chips: the chosen one lit, the rest answering the pointer.
public struct KOSChoices<Value: Hashable>: View {
  private let options: [(value: Value, label: String)]
  private let selected: Value
  private let choose: (Value) -> Void

  public init(_ options: [(value: Value, label: String)], selected: Value, choose: @escaping (Value) -> Void) {
    self.options = options
    self.selected = selected
    self.choose = choose
  }

  public var body: some View {
    HStack(spacing: 6) {
      ForEach(options, id: \.value) { option in
        Button(option.label) { choose(option.value) }
          .buttonStyle(ChipStyle(selected: option.value == selected))
      }
    }
  }
}

/// A chip: lit when chosen, lighter under the pointer, a touch smaller pressed.
public struct ChipStyle: ButtonStyle {
  private let selected: Bool

  public init(selected: Bool) {
    self.selected = selected
  }

  public func makeBody(configuration: Configuration) -> some View {
    Chip(selected: selected, configuration: configuration)
  }

  private struct Chip: View {
    let selected: Bool
    let configuration: ButtonStyleConfiguration
    @State private var hovering = false

    var body: some View {
      configuration.label
        .font(.kos(.detail, selected ? .semibold : .medium))
        .foregroundStyle(selected ? Theme.accent : hovering ? Theme.text : Theme.muted)
        .padding(.horizontal, 10)
        .padding(.vertical, 5.5)
        .background(selected ? Theme.accent.opacity(Theme.tint) : hovering ? Theme.line.opacity(0.7) : Theme.panel2, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous).strokeBorder(selected ? Theme.accent.opacity(Theme.edge) : hovering ? Theme.lineStrong : Theme.line))
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .pointingHand()
        .animation(Theme.hover, value: hovering)
        .animation(Theme.hover, value: selected)
    }
  }
}

/// Minutes in the shortest words: "45 min", "2 h", "1 h 30".
public func minutesWords(_ minutes: Int) -> String {
  if minutes < 60 { return "\(minutes) min" }
  let hours = minutes / 60, rest = minutes % 60
  return rest == 0 ? "\(hours) h" : "\(hours) h \(rest)"
}

/// A text field on a dark well, with its label above it when it has one.
public struct KOSField: View {
  private let label: String?
  private let placeholder: String
  @Binding private var text: String
  private let mono: Bool

  public init(_ label: String?, placeholder: String, text: Binding<String>, mono: Bool = false) {
    self.label = label
    self.placeholder = placeholder
    _text = text
    self.mono = mono
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      if let label { Text(label).font(.kos(.small, .medium)).foregroundStyle(Theme.muted) }
      TextField("", text: $text, prompt: Text(placeholder).foregroundColor(Theme.faint))
        .textFieldStyle(.plain)
        .font(.kos(.dense, design: mono ? .monospaced : .default))
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous).strokeBorder(Theme.line))
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
        .animation(Theme.hover, value: isOn)
        .animation(Theme.hover, value: hovering)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .accessibilityAddTraits(.isToggle)
    .accessibilityValue(isOn ? "On" : "Off")
  }
}
