import AppKit
import SwiftUI

/// The few controls every window here is made of, drawn in KOS's own style
/// rather than the system's grey, so they match the dashboard. A window
/// builds from these; one that draws its own copy of one drifts from it.

/// A group on a panel, like a card on the dashboard. `tone` edges it in a
/// colour (an ask is the warn's), `wash` fills it with that colour's faint
/// tint instead of the panel (a quote, a notice). A card that is itself a
/// choice is `picked` on the accent's tint when chosen, and `lit` under the pointer.
public struct Card<Content: View>: View {
  private let tone: Color?
  private let wash: Bool
  private let picked: Bool
  private let lit: Bool
  private let padding: EdgeInsets
  private let spacing: CGFloat
  private let content: Content

  public init(tone: Color? = nil, wash: Bool = false, picked: Bool = false, lit: Bool = false, padding: EdgeInsets = EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14), spacing: CGFloat = 10, @ViewBuilder content: () -> Content) {
    self.tone = tone
    self.wash = wash
    self.picked = picked
    self.lit = lit
    self.padding = padding
    self.spacing = spacing
    self.content = content()
  }

  /// Even padding all round.
  public init(tone: Color? = nil, wash: Bool = false, picked: Bool = false, lit: Bool = false, padding: CGFloat, spacing: CGFloat = 10, @ViewBuilder content: () -> Content) {
    self.init(tone: tone, wash: wash, picked: picked, lit: lit, padding: EdgeInsets(top: padding, leading: padding, bottom: padding, trailing: padding), spacing: spacing, content: content)
  }

  private var fill: Color {
    if picked { return Theme.accent.opacity(Theme.tint) }
    if wash { return (tone ?? Theme.accent).opacity(0.08) }
    return lit ? Theme.panel2 : Theme.panel
  }

  private var edge: Color {
    if picked { return Theme.accent.opacity(Theme.edge) }
    if let tone { return tone.opacity(wash ? 0.25 : Theme.edge).blended(over: Theme.line) }
    return lit ? Theme.lineStrong : Theme.line
  }

  public var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous)
    VStack(alignment: .leading, spacing: spacing) { content }
      .padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(fill, in: shape)
      .overlay(shape.strokeBorder(edge, lineWidth: picked ? 1.5 : 1))
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
/// What a step saw (a tab, a screen), as the dashboard's and the side panel's StepPicture (kit):
/// small under its step, larger when `open`, a press asking for the other.
public struct StepPicture: View {
  /// How wide it is small.
  public static let small: CGFloat = 150
  private let image: NSImage?
  private let open: Bool
  private let press: () -> Void

  public init(_ data: Data, open: Bool = false, press: @escaping () -> Void = {}) {
    image = NSImage(data: data)
    self.open = open
    self.press = press
  }

  public var body: some View {
    if let image {
      Button(action: press) {
        Image(nsImage: image)
          .resizable()
          .aspectRatio(contentMode: .fit)
          .frame(maxWidth: open ? .infinity : Self.small, alignment: .leading)
          .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous).strokeBorder(Theme.line))
      }
      .buttonStyle(.plain)
      .help(open ? "Smaller" : "What this step saw")
      .accessibilityLabel("What this step saw")
    }
  }
}

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
      .font(.kos(small ? .detail : .table, .medium))
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
/// `bare` is the small one inside a tag or a row (the kit's .icon-btn--bare): no ring, its tint's wash under the pointer.
public struct IconButton: View {
  private let symbol: String
  private let label: String
  /// The colour it takes under the pointer, for one that does something final, like Close.
  private let tint: Color?
  private let bare: Bool
  private let action: () -> Void
  @State private var hovering = false

  public init(symbol: String, label: String, tint: Color? = nil, bare: Bool = false, action: @escaping () -> Void) {
    self.symbol = symbol
    self.label = label
    self.tint = tint
    self.bare = bare
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(bare ? .system(size: 8.5, weight: .bold) : .kos(.control, .semibold))
        .foregroundStyle(hovering ? (tint ?? Theme.text) : bare ? Theme.faint : Theme.muted)
        .frame(width: bare ? 14 : 26, height: bare ? 14 : 26)
        .background(hovering ? (tint?.opacity(Theme.tint) ?? (bare ? .clear : Theme.panel2)) : .clear, in: Circle())
        .overlay(Circle().strokeBorder(hovering && !bare ? (tint?.opacity(Theme.edge) ?? Theme.line) : .clear))
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
/// `opens` adds the chevron of one that opens something: nil for none, true turned while it is open.
public struct Chip: View {
  private let symbol: String?
  private let text: String
  private let lit: Bool
  private let pressable: Bool
  private let opens: Bool?

  public init(_ text: String, symbol: String? = nil, lit: Bool = false, pressable: Bool = true, opens: Bool? = nil) {
    self.text = text
    self.symbol = symbol
    self.lit = lit
    self.pressable = pressable
    self.opens = opens
  }

  public var body: some View {
    HStack(spacing: 4) {
      if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
      Text(text).lineLimit(1).truncationMode(.tail)
      if let opens {
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(opens ? 180 : 0))
      }
    }
    .chip(lit: lit, pressable: pressable)
  }
}

/// A fact in a word or two on a bordered capsule, not a state: the web kit's Tag. What leads it
/// (an app's icon) is drawn first, and one that can be taken away carries its bare cross.
public struct Tag<Leading: View>: View {
  private let text: String
  private let leading: Leading
  private let remove: (label: String, action: () -> Void)?
  @State private var hovering = false

  public init(_ text: String, remove: (label: String, action: () -> Void)? = nil, @ViewBuilder leading: () -> Leading) {
    self.text = text
    self.leading = leading()
    self.remove = remove
  }

  public var body: some View {
    HStack(spacing: 5) {
      leading
      Text(text).font(.kos(.small, .medium)).foregroundStyle(Theme.text).lineLimit(1)
      if let remove {
        IconButton(symbol: "xmark", label: remove.label, tint: Theme.danger, bare: true, action: remove.action)
      }
    }
    .padding(.leading, 7)
    .padding(.trailing, remove == nil ? 7 : 5)
    .padding(.vertical, 4)
    .background(hovering ? Theme.line.opacity(0.7) : Theme.panel2, in: Capsule())
    .overlay(Capsule().strokeBorder(hovering ? Theme.lineStrong : Theme.line))
    .onHover { hovering = $0 }
    .animation(Theme.hover, value: hovering)
  }
}

extension Tag where Leading == EmptyView {
  public init(_ text: String, remove: (label: String, action: () -> Void)? = nil) {
    self.init(text, remove: remove) { EmptyView() }
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
  private let round: CGFloat?

  /// `capsule` for a button inside something round, such as the session bar, whose corners a small radius would fight;
  /// `small` for one among words, as the extension's .btn--sm is; `round` for a circle of that size holding a symbol,
  /// the send button, which with nothing to do greys on the line rather than fading, as the dashboard's .send does.
  public init(_ kind: Kind = .secondary, capsule: Bool = false, small: Bool = false, round: CGFloat? = nil) {
    self.kind = kind
    self.capsule = capsule
    self.small = small
    self.round = round
  }

  public func makeBody(configuration: Configuration) -> some View {
    StyledButton(kind: kind, radius: capsule ? 999 : Theme.radiusSm, small: small, round: round, configuration: configuration)
  }

  private struct StyledButton: View {
    let kind: Kind
    let radius: CGFloat
    let small: Bool
    let round: CGFloat?
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
      let lit = hovering && enabled
      if let round {
        configuration.label
          .foregroundStyle(enabled ? foreground(lit) : Theme.faint)
          .frame(width: round, height: round)
          .background(enabled ? background(lit: lit, pressed: false) : Theme.line, in: Circle())
          .scaleEffect(configuration.isPressed ? 0.97 : 1)
          .contentShape(Circle())
          .onHover { hovering = $0 }
          .pointingHand(enabled)
          .animation(Theme.hover, value: lit)
          .animation(Theme.press, value: configuration.isPressed)
      } else {
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

/// How long KOS has been at it, as the web kit's formatElapsed says it: "45s", "3m 20s", "1h 4m".
public func elapsedWords(_ seconds: TimeInterval) -> String {
  let total = max(0, Int(seconds.rounded()))
  if total < 60 { return "\(total)s" }
  let minutes = total / 60
  if minutes < 60 { return "\(minutes)m \(total % 60)s" }
  return "\(minutes / 60)h \(minutes % 60)m"
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
