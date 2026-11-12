import DeviceCore
import DeviceKit
import Foundation

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

  /// What the shelf says to KOS; the app sends it on the line.
  public var tell: (ChatEvent) -> Void = { _ in }

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
    shown = .loading(id: id, title: title ?? recent.first { $0.id == id }?.title)
    tell(.artifact(id: id, theme: dark ? "dark" : "light"))
  }

  public func close() {
    failReads("The artifact was closed.")
    shown = nil
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

  public func received(_ answer: ArtifactReadAnswer) {
    guard case .open(let artifact) = shown, artifact.id == answer.artifact else { return }
    settle(answer.call, answer.error.map { .failure(ReadRefusal($0)) } ?? .success(answer.result ?? .null))
  }

  /// Another KOS, or none: nothing of the last one's stays.
  public func reset() {
    failReads("The line to KOS closed.")
    recent = []
    listed = false
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
