import DeviceCore
import Foundation

/// The chat calls a KOS makes (docs/browser-extension.md), read off the wire
/// and drawn into a ChatModel: one reading for every device that draws the
/// chat, the Mac's window and the phone alike. The app around it answers the
/// call and keeps its own timers by what it was.
@MainActor
public enum ChatCalls {
  /// What a call was, for the app's timers: the chat shown, a turn's status, or anything else.
  public enum Heard: Equatable, Sendable {
    case shown, status, other
  }

  /// Draws the call into the model. Throws a bad request for params that do not read, which the app answers with.
  @discardableResult
  public static func draw(_ call: Call, as method: ChatMethod, into model: ChatModel) throws -> Heard {
    switch method {
    case .show:
      let p = try call.params(ChatShow.self)
      model.silent = false
      model.show(
        conversation: p.chat ?? p.conversation, title: p.title, lines: p.messages.compactMap(line),
        notice: p.notice.map { ($0.text, $0.from, $0.waiting ?? false) }, auto: p.auto ?? false,
        // Keys that read as the same number ("7" and "07") keep the last: never a trap on a duplicate.
        pictures: Dictionary((p.pictures ?? [:]).compactMap { k, v in Int(k).map { ($0, v) } }, uniquingKeysWith: { _, last in last }))
      return .shown
    case .status:
      let p = try call.params(ChatStatus.self)
      // A step's picture comes on its own: the turn's story is told apart, and is not ended by it.
      if let frame = p.frame {
        model.frame(frame.id, image: frame.image, said: p.said, conversation: p.turnChat)
        return .status
      }
      model.status(
        taken: p.taken ?? false, story: p.story, error: p.error, said: p.said, conversation: p.turnChat,
        waiting: p.waiting.flatMap { ChatModel.Wait(rawValue: $0.rawValue) }, held: p.held ?? false, command: p.command)
      return .status
    case .ask:
      let p = try call.params(ChatAsk.self)
      model.ask(ask(p.approval, chat: p.chat))
    case .settled:
      model.settled(try call.params(ChatSettled.self).approval)
    case .chats:
      let p = try call.params(ChatChats.self)
      model.chats(p.chats.map { .init(id: $0.id, title: $0.title, updated: Date(timeIntervalSince1970: $0.updatedAt / 1000), place: $0.place.map(place)) })
    case .models:
      let p = try call.params(ChatModels.self)
      model.models(.init(current: p.current, choices: p.choices, fixed: p.fixed), error: p.error)
    case .mentions:
      let p = try call.params(ChatMentions.self)
      model.mentions(p.mentions.map { .init(kind: $0.kind, id: $0.id, label: $0.label, hint: $0.hint) }, for: p.q)
    }
    return .other
  }

  /// An approval as KOS sends it, as the model holds it: in `chat.ask`, and in a phone's glance.
  public static func ask(_ a: ChatApproval, chat: String?) -> ChatModel.Ask {
    .init(
      id: a.id, tool: a.tool, summary: a.summary, args: a.args, mechanics: a.mechanics, why: a.why, reason: a.reason, always: a.always,
      expires: a.expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) }, chat: chat)
  }

  /// One entry of the chat as KOS sends it, as a window draws it; one of a role this app does not know is left out.
  public static func line(_ m: ChatMessage) -> ChatModel.Line? {
    switch m.role {
    case "you": return .you(m.text ?? "", files: m.files ?? [], quote: m.quote.map { .init(text: $0.text, from: $0.from) })
    case "kos": return m.text.map { .kos($0) }
    case "note": return m.text.map { .note($0) }
    case "steps": return .steps((m.steps ?? []).map { .init(summary: $0.summary, failed: $0.failed ?? false, frame: $0.frame) })
    default: return nil
    }
  }

  /// Where a chat or an artifact lives, as KOS says it.
  public static func place(_ p: ChatPlace) -> ChatModel.Place {
    switch p.kind {
    case "project": return .project(p.name ?? "A project")
    case "blob": return .blob(p.name ?? "A blob")
    default: return .kos
    }
  }
}
