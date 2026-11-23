import DeviceCore
import SwiftUI

/// The chat's mode in the composer, as the dashboard's and the side panel's mode chip: the hand in Ask, the bolt
/// and the accent in Auto, with how long Auto has left. A press on the words in Auto goes back to Ask, and in Ask
/// opens `ModeMenu`, as the chevron does: going into Auto is a choice made in the menu, never one press or a key. The words count down each half minute, and an Auto whose time ran out reads as Ask.
public struct ModeChip: View {
  private let mode: ChatMode
  private let open: Bool
  private let keys: Bool
  private let height: CGFloat
  private let cycle: () -> Void
  private let menu: () -> Void
  @State private var hovering = false

  /// `keys`: a pointer's, so the tooltip says press rather than tap. `height`: the row's, where the composer's controls are
  /// taller than a chip (the phone's).
  public init(mode: ChatMode, open: Bool = false, keys: Bool = true, height: CGFloat = 24, cycle: @escaping () -> Void, menu: @escaping () -> Void) {
    self.mode = mode
    self.open = open
    self.keys = keys
    self.height = height
    self.cycle = cycle
    self.menu = menu
  }

  public var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      let live = mode.live(now: context.date)
      let lit = live.mode == .auto
      HStack(spacing: 0) {
        Button(action: lit ? cycle : menu) {
          HStack(spacing: 4) {
            Image(systemName: lit ? "bolt.fill" : "hand.raised").font(.system(size: height > 30 ? 13 : 10, weight: .semibold))
            Text(live.label(now: context.date)).lineLimit(1).fixedSize()
          }
          .padding(.leading, height > 30 ? 16 : 10)
          .padding(.trailing, 5)
          .frame(maxHeight: .infinity)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Mode: \(live.label(now: context.date))")
        .accessibilityHint(lit ? "Goes back to Ask" : "Opens the modes to choose from")
        Button(action: menu) {
          Image(systemName: "chevron.down").font(.system(size: height > 30 ? 10 : 8, weight: .bold))
            .rotationEffect(.degrees(open ? 180 : 0))
            .padding(.leading, 3)
            .padding(.trailing, height > 30 ? 16 : 9)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Mode options")
      }
      .font(.kos(height > 30 ? .dense : .detail))
      .foregroundStyle(lit ? Theme.accent : hovering ? Theme.text : Theme.muted)
      .frame(height: height)
      .background(Capsule().fill(lit ? Theme.accent.opacity(Theme.tint).blended(over: Theme.panel) : hovering ? Theme.line : Theme.panel2))
      .contentShape(Capsule())
      .onHover { hovering = $0 }
      .pointingHand()
      .animation(Theme.hover, value: hovering)
      .animation(Theme.spring, value: open)
      .help(live.tip(now: context.date, keys: keys))
    }
    .fixedSize(horizontal: true, vertical: false)
  }
}

/// What the mode chip opens: Ask or Auto, how long Auto lasts, whether it starts sessions too, and what Auto never
/// covers. Drawn by the window itself, as the / menu is, so it looks the same on the Mac and the phone. `choose`
/// is told each change; picking a mode or a span is done with it, the sessions switch is not.
public struct ModeMenu: View {
  private let mode: ChatMode
  private let now: Date
  private let choose: (ChatMode) -> Void

  public init(mode: ChatMode, now: Date = Date(), choose: @escaping (ChatMode) -> Void) {
    self.mode = mode.live(now: now)
    self.now = now
    self.choose = choose
  }

  public var body: some View {
    let auto = mode.mode == .auto
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 6) {
        SectionLabel("Mode")
        KOSChoices(ChatMode.Name.allCases.map { ($0, $0 == .auto ? "Auto" : "Ask") }, selected: mode.mode) { choose(mode.picking($0)) }
        Text(ChatMode.short(mode.mode)).font(.kos(.small)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      VStack(alignment: .leading, spacing: 6) {
        SectionLabel(auto && mode.span == nil ? "Auto lasts · \(ChatMode.leftWords(left)) left" : "Auto lasts")
        KOSChoices(ChatMode.Span.allCases.map { (Optional($0), $0.short) }, selected: auto ? mode.span : nil) { span in
          if let span { choose(mode.lasting(span, now: now)) }
        }
      }
      Hairline()
      SwitchRow(ChatMode.sessionsLabel, ChatMode.sessionsHint, isOn: auto && mode.sessions) { on in choose(mode.starting(sessions: on)) }
        .disabled(!auto)
        .opacity(auto ? 1 : 0.5)
      Hairline()
      VStack(alignment: .leading, spacing: 3) {
        SectionLabel("Auto never covers").padding(.bottom, 2)
        ForEach(ChatMode.never, id: \.self) { line in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("·").foregroundStyle(Theme.faint)
            Text(line).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
          }
          .font(.kos(.small))
        }
      }
      .accessibilityElement(children: .combine)
    }
  }

  /// What a timed Auto has left.
  private var left: TimeInterval {
    if case .at(let end) = mode.until { return end.timeIntervalSince(now) }
    return 0
  }
}
