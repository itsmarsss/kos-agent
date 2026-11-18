import DeviceCore
import DeviceKit
import SwiftUI

/// What KOS is at on this Mac, as the menu bar says it: nothing, at work on a
/// step, waiting on the owner, or paused while the owner has the Mac. Read
/// from the session (what KOS said it is at, whichever chat the window shows)
/// and from the chat window's own chat.
public struct MenuTurn: Equatable {
  public enum State: Equatable { case idle, working, waiting, paused }

  public var state: State
  /// The step under way, in its words; "Thinking" between steps.
  public var step: String?
  /// What the session is for, while KOS has this Mac.
  public var task: String?
  /// Which KOS, when this Mac is paired with several.
  public var kos: String?
  /// The first approval waiting in the window's chat, to decide from the menu.
  public var ask: ChatModel.Ask?
  /// A session is live: it can be taken over and given more time.
  public var session: Bool

  public init(state: State, step: String? = nil, task: String? = nil, kos: String? = nil, ask: ChatModel.Ask? = nil, session: Bool = false) {
    self.state = state
    self.step = step
    self.task = task
    self.kos = kos
    self.ask = ask
    self.session = session
  }

  public static let idle = MenuTurn(state: .idle)

  /// Paused while the owner has the Mac, waiting while an approval or a session's ask is up, working while a session or
  /// the window's turn goes on, else idle. The step is the session's, as KOS said it, else the window's foot.
  @MainActor public static func of(session: LiveSession?, kos: String? = nil, chat: ChatModel) -> MenuTurn {
    let state: State
    if session?.paused == true || chat.heldByOwner {
      state = .paused
    } else if session?.waiting == true || chat.waitingOnOwner {
      state = .waiting
    } else if session != nil || chat.working {
      state = .working
    } else {
      return .idle
    }
    let foot = chat.working && !chat.waitingOnOwner && !chat.heldByOwner ? chat.foot : nil
    return MenuTurn(state: state, step: session?.step ?? foot, task: session?.task, kos: kos, ask: chat.asks.first, session: session != nil)
  }

  /// The longest the words beside the icon run.
  public static let titleLength = 24

  /// The words beside the icon: the step at work, cut to fit, or that KOS waits on the owner.
  public var title: String? {
    switch state {
    case .working: return step.map(Self.cut)
    case .waiting: return "Waiting on you"
    case .idle, .paused: return nil
    }
  }

  /// What the head of the menu says.
  public var headline: String {
    switch state {
    case .idle: return "Nothing running"
    case .working: return session ? "KOS is using this Mac" : "KOS is working"
    case .waiting: return "Waiting on you"
    case .paused: return "Paused, you have control"
    }
  }

  /// The line under it: the ask to decide, the step at work, or what the session is for.
  public var detail: String? {
    let what: String?
    switch state {
    case .waiting: what = ask.map { $0.summary ?? $0.tool } ?? task
    case .working: what = step ?? task
    case .paused: what = task
    case .idle: what = nil
    }
    return kos.map { k in what.map { "\($0), for \(k)" } ?? "For \(k)" } ?? what
  }

  static func cut(_ words: String) -> String {
    guard words.count > titleLength else { return words }
    return String(words.prefix(titleLength - 1)).trimmingCharacters(in: .whitespaces) + "…"
  }
}

/// What the turn's menu does, each closing the menu after it.
public struct MenuTurnActions {
  public var approve: (String) -> Void = { _ in }
  public var deny: (String) -> Void = { _ in }
  public var openChat: () -> Void = {}
  public var takeOver: () -> Void = {}
  public var handBack: () -> Void = {}
  public var extend: () -> Void = {}
  public var stop: () -> Void = {}

  public init() {}
}

/// The top of the menu bar's menu while KOS works: where it stands, the step
/// or the ask, and what the owner can do about it, Stop always last.
public struct TurnMenu: View {
  let turn: MenuTurn
  let actions: MenuTurnActions

  public static let width: CGFloat = 280
  /// How wide the rows' symbols stand, and the head's dot with them.
  static let symbolColumn: CGFloat = 16

  public init(turn: MenuTurn, actions: MenuTurnActions) {
    self.turn = turn
    self.actions = actions
  }

  private var tone: Color {
    switch turn.state {
    case .paused, .waiting: return Theme.warn
    case .working: return Theme.accent
    case .idle: return Theme.muted
    }
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Dot(tone, size: 7).frame(width: Self.symbolColumn).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
        VStack(alignment: .leading, spacing: 2) {
          Text(turn.headline).font(.kos(.control, .semibold)).foregroundStyle(Theme.text)
          if let detail = turn.detail {
            Text(detail).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(2).truncationMode(.tail)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      ForEach(rows, id: \.title) { row in
        MenuRow(action: row.action) { _ in
          HStack(spacing: 8) {
            // One column for the symbols, so every row's words start together.
            Image(systemName: row.symbol).frame(width: Self.symbolColumn)
            Text(row.title)
          }
          .font(.kos(.control, row.strong ? .semibold : .regular))
          .foregroundStyle(row.tone ?? Theme.text)
        }
      }
    }
    .padding(5)
    .frame(width: Self.width, alignment: .leading)
  }

  private struct Row {
    let title: String
    let symbol: String
    var tone: Color?
    var strong = false
    let action: () -> Void
  }

  private var rows: [Row] {
    var out: [Row] = []
    switch turn.state {
    case .waiting:
      if let ask = turn.ask {
        out.append(Row(title: "Approve", symbol: "checkmark", tone: Theme.accent, strong: true) { actions.approve(ask.id) })
        out.append(Row(title: "Deny", symbol: "xmark") { actions.deny(ask.id) })
      }
    case .paused:
      out.append(Row(title: "Hand back", symbol: "hand.raised", tone: Theme.accent, strong: true, action: actions.handBack))
    case .working:
      if turn.session { out.append(Row(title: "Take over", symbol: "hand.raised", action: actions.takeOver)) }
    case .idle:
      break
    }
    if turn.session && turn.state != .idle { out.append(Row(title: "Give it 15 more minutes", symbol: "clock", action: actions.extend)) }
    out.append(Row(title: "Open chat", symbol: "bubble.left", action: actions.openChat))
    out.append(Row(title: "Stop", symbol: "stop.fill", tone: Theme.danger, action: actions.stop))
    return out
  }
}
