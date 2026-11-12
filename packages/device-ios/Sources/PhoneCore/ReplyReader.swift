import DeviceKit
import Foundation

/// Speak replies: with it on, each reply KOS gives is read aloud as it lands
/// in the chat, as plain words. What was in the chat before is never read,
/// another chat's history is not, and Stop or the owner's voice silences it.
@MainActor
public final class ReplyReader: ObservableObject {
  @Published public var on: Bool {
    didSet {
      guard on != oldValue else { return }
      preferences.setValue(on, Self.key)
      if !on { speaker.stop() }
    }
  }

  private let speaker: Speaker
  private let preferences: Preferences
  /// The chat last shown and its lines, to tell which of the next are new.
  private var shown: (conversation: String?, lines: [ChatModel.Line])?

  static let key = "speakReplies"

  public init(speaker: Speaker, preferences: Preferences) {
    self.speaker = speaker
    self.preferences = preferences
    on = preferences.value(Bool.self, Self.key) ?? false
  }

  /// The chat as KOS just showed it: KOS's words that are new since it was last shown are read, when on.
  public func shown(conversation: String?, lines: [ChatModel.Line]) {
    defer { shown = (conversation, lines) }
    guard on, let last = shown, last.conversation == conversation, conversation != nil else { return }
    for line in Self.added(from: last.lines, to: lines) {
      if case .kos(let text) = line {
        let words = SpokenWords.plain(text)
        if !words.isEmpty { speaker.speak(words) }
      }
    }
  }

  /// Quiet now: Stop, the owner speaking, the app going away.
  public func stop() {
    speaker.stop()
  }

  /// The lines `next` has after what `last` had. A chat shown is its latest lines only, so the oldest may have
  /// gone off its top: the new ones are those after the longest end of `last` that `next` starts with.
  static func added(from last: [ChatModel.Line], to next: [ChatModel.Line]) -> ArraySlice<ChatModel.Line> {
    guard !last.isEmpty else { return next[next.endIndex...] }
    for drop in 0..<last.count {
      let tail = last[(last.startIndex + drop)...]
      if tail.count <= next.count, next.prefix(tail.count).elementsEqual(tail) { return next[tail.count...] }
    }
    // Nothing in common: a chat redrawn whole, not one that went on; nothing in it is news.
    return next[next.endIndex...]
  }
}

/// KOS's markdown as words to say: the marks gone, links by their words, a
/// time as it reads, and what does not read aloud (code, a table) named, not spelled out.
public enum SpokenWords {
  public static func plain(_ markdown: String, now: Date = Date()) -> String {
    var out: [String] = []
    var inCode = false
    var saidCode = false
    var inTable = false
    for raw in markdown.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("```") {
        inCode.toggle()
        if inCode && !saidCode {
          out.append("There is some code on screen.")
          saidCode = true
        }
        continue
      }
      if inCode { continue }
      if line.hasPrefix("|") {
        if !inTable { out.append("There is a table on screen.") }
        inTable = true
        continue
      }
      inTable = false
      if line.isEmpty { continue }
      out.append(words(of: line, now: now))
    }
    return out.filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// One line's words: its heading, list or quote marks gone, then each inline mark.
  private static func words(of line: String, now: Date) -> String {
    var text = line
    text = text.replacingOccurrences(of: #"^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)"#, with: "", options: .regularExpression)
    text = ChatTime.inWords(text, now: now)
    text = text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    text = text.replacingOccurrences(of: #"https?://\S+"#, with: "a link", options: .regularExpression)
    // A reference to one of KOS's own things reads as its name: @project:garden as garden.
    text = text.replacingOccurrences(of: #"@[a-z]+:(?:\[([^\]]*)\]|([^\s\]]+))"#, with: "$1$2", options: .regularExpression)
    text = text.replacingOccurrences(of: #"\$\$?([^$]+)\$\$?"#, with: "$1", options: .regularExpression)
    // Emphasis and code marks around words go; an underscore inside a name (file_name) stays.
    for pattern in [#"\*\*(.+?)\*\*"#, #"__(.+?)__"#, #"~~(.+?)~~"#, #"`([^`]*)`"#, #"\*(\S.*?)\*"#, #"(?<![\w])_(\S.*?)_(?![\w])"#] {
      text = text.replacingOccurrences(of: pattern, with: "$1", options: .regularExpression)
    }
    return text.trimmingCharacters(in: .whitespaces)
  }
}
