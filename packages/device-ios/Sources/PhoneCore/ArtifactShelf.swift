import DeviceCore
import DeviceKit
import Foundation
import OSLog

/// The owner's artifacts on the phone (docs/computer.md, Artifacts): the
/// ones changed last, to pick from, and the one open, as KOS drew it for
/// the dashboard's frame, read-only. A read the open artifact's window.kos
/// makes goes to KOS by a call number of the phone's own and comes back by
/// it; nothing the page asks changes anything.
@MainActor
public final class ArtifactShelf: ObservableObject {
  /// One open, as KOS sent it.
  public struct Artifact: Equatable, Sendable {
    public let id: String
    public let title: String
    public let kind: String
    public let place: ChatModel.Place?
    public let updated: Date?
    /// The wrapper document holding the page's.
    public let document: String
    /// Each theme's tokens as the rule the page's bridge takes.
    public let themes: ArtifactOpened.Themes
    /// The theme the document was drawn in.
    public let dark: Bool

    public init(
      id: String, title: String, kind: String, place: ChatModel.Place? = nil, updated: Date? = nil, document: String,
      themes: ArtifactOpened.Themes, dark: Bool
    ) {
      self.id = id
      self.title = title
      self.kind = kind
      self.place = place
      self.updated = updated
      self.document = document
      self.themes = themes
      self.dark = dark
    }
  }

  /// What the viewer shows: one on its way, one open, or why one could not be.
  public enum Shown: Equatable, Sendable {
    case loading(id: String, title: String?)
    case open(Artifact)
    case failed(id: String, title: String?, why: String)

    public var id: String {
      switch self {
      case .loading(let id, _), .failed(let id, _, _): return id
      case .open(let artifact): return artifact.id
      }
    }

    public var title: String? {
      switch self {
      case .loading(_, let title), .failed(_, let title, _): return title
      case .open(let artifact): return artifact.title
      }
    }
  }

  /// A sheet's row the owner tapped, every field labelled, as the sheet's runtime tells it: drawn by the phone as a
  /// sheet of its own rather than in the page.
  public struct Row: Equatable, Identifiable, Sendable {
    public struct Field: Equatable, Sendable {
      public let label: String
      public let value: String
      public let numeric: Bool

      public init(label: String, value: String, numeric: Bool) {
        self.label = label
        self.value = value
        self.numeric = numeric
      }
    }

    public let id = UUID()
    /// The tab it is in.
    public let sheet: String
    public let title: String
    public let fields: [Field]

    /// The most fields and characters a row carries, as the runtime cuts them (sheet.ts, rowReport).
    public static let most = 200
    public static let longest = 2000

    /// What the page posted, held to the runtime's own caps; nil when it is not a row.
    public init?(sheet: Any?, title: Any?, fields: Any?) {
      guard let title = title as? String, let list = fields as? [[String: Any]] else { return nil }
      let cut = { (text: String) in String(text.prefix(Self.longest)) }
      self.sheet = cut(sheet as? String ?? "")
      self.title = cut(title)
      self.fields = list.prefix(Self.most).compactMap { field in
        guard let label = field["label"] as? String, let value = field["value"] as? String else { return nil }
        return Field(label: cut(label), value: cut(value), numeric: field["numeric"] as? Bool ?? false)
      }
    }

    public static func == (a: Row, b: Row) -> Bool { a.sheet == b.sheet && a.title == b.title && a.fields == b.fields }
  }

  /// A read's answer as the page takes it: the result, or the words it is refused in.
  public typealias Answer = Result<JSONValue, ReadRefusal>

  public struct ReadRefusal: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
  }

  /// The ones changed last, as KOS last listed them.
  @Published public private(set) var recent: [ArtifactItem] = []
  /// KOS has answered the list since it was last asked for.
  @Published public private(set) var listed = false
  @Published public private(set) var shown: Shown?
  /// The open sheet's row the owner tapped, shown over it until put away.
  @Published public var row: Row?

  /// What the shelf says to KOS; the app sends it on the line.
  public var tell: (ChatEvent) -> Void = { _ in }

  private static let log = Logger(subsystem: "com.itsmarsss.kos-phone", category: "artifacts")
  private var calls = 0
  private var reads: [Int: (Answer) -> Void] = [:]
  /// How long a read waits on KOS before the page is told it is not coming; the page's own bridge waits ten seconds.
  private let readWithin: Duration
  private let sleep: @Sendable (Duration) async -> Void

  public init(readWithin: Duration = .seconds(9), sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
    self.readWithin = readWithin
    self.sleep = sleep
  }

  // MARK: The owner

  /// Asks KOS for the ones changed last.
  public func list() {
    listed = false
    tell(.artifacts)
  }

  /// Opens one by its id, drawn in the phone's theme; an id that is not an artifact's is refused here.
  public func open(_ id: String, title: String? = nil, dark: Bool) {
    guard ArtifactLink.isId(id) else {
      shown = .failed(id: id, title: title, why: "That is not an artifact's id.")
      return
    }
    failReads("The artifact was closed.")
    row = nil
    shown = .loading(id: id, title: title ?? recent.first { $0.id == id }?.title)
    tell(.artifact(id: id, theme: dark ? "dark" : "light"))
  }

  public func close() {
    failReads("The artifact was closed.")
    row = nil
    shown = nil
  }

  /// A row the open sheet told of, at the owner's tap; from any other kind, or with nothing open, nothing shows.
  public func tapped(_ row: Row) {
    guard case .open(let artifact) = shown, artifact.kind == "sheet" else { return }
    self.row = row
  }

  /// A read the open artifact's page asked for, answered once; a page asking for another artifact's is refused.
  public func read(_ method: String, args: JSONValue, answer: @escaping (Answer) -> Void) {
    guard case .open(let artifact) = shown else { return answer(.failure(ReadRefusal("The artifact is not open."))) }
    guard method == "query" || method == "file" else { return answer(.failure(ReadRefusal("A phone only reads an artifact."))) }
    calls += 1
    let call = calls
    reads[call] = answer
    tell(.read(artifact: artifact.id, call: call, method: method, args: args))
    let sleep = sleep, within = readWithin
    Task { [weak self] in
      await sleep(within)
      self?.settle(call, .failure(ReadRefusal("KOS did not answer in time; try again.")))
    }
  }

  // MARK: KOS

  public func received(_ list: ArtifactList) {
    recent = list.artifacts
    listed = true
  }

  /// One drawn, or why not: only the one being opened is taken.
  public func received(_ opened: ArtifactOpened) {
    guard case .loading(let id, let title) = shown, opened.id == id else { return }
    if let error = opened.error {
      // Why is KOS's to say in its own words, which are not always the owner's: kept in the log, and shown plainly.
      Self.log.notice("artifact \(id, privacy: .public) did not open: \(error, privacy: .public)")
      shown = .failed(id: id, title: title, why: error)
    } else if let document = opened.document, let themes = opened.themes {
      shown = .open(
        Artifact(
          id: id, title: opened.title ?? title ?? id, kind: opened.kind ?? "page", place: opened.place.map(ChatCalls.place),
          updated: opened.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }, document: document, themes: themes, dark: opened.theme == "dark"))
    } else {
      shown = .failed(id: id, title: title, why: "KOS sent that artifact in a shape this app does not read.")
    }
  }

  /// The open one cannot be shown here as it must be held (the viewer's own failure): it is shown as one that did not open.
  public func cannotShow(_ id: String, _ why: String) {
    guard shown?.id == id else { return }
    Self.log.error("artifact \(id, privacy: .public) not shown: \(why, privacy: .public)")
    failReads("The artifact was closed.")
    shown = .failed(id: id, title: shown?.title, why: why)
  }

  public func received(_ answer: ArtifactReadAnswer) {
    guard case .open(let artifact) = shown, artifact.id == answer.artifact else { return }
    settle(answer.call, answer.error.map { .failure(ReadRefusal($0)) } ?? .success(answer.result ?? .null))
  }

  /// Another KOS, or none: nothing of the last one's stays.
  public func reset() {
    failReads("The line to KOS closed.")
    recent = []
    listed = false
    row = nil
    shown = nil
  }

  private func settle(_ call: Int, _ answer: Answer) {
    reads.removeValue(forKey: call)?(answer)
  }

  private func failReads(_ why: String) {
    let waiting = reads
    reads = [:]
    for (_, answer) in waiting { answer(.failure(ReadRefusal(why))) }
  }
}
