import DeviceCore
import Foundation

/// The Inbox, as the dashboard's: what waits on the owner first, each to
/// approve or deny, the jobs failing under it, then what was decided, a page
/// at a time, newest first, held to one outcome or some words as the owner
/// asks (`/api/approvals/history`). A decision goes as the dashboard's does,
/// with this phone as who decided.
@MainActor
public final class InboxModel: ObservableObject {
  /// The outcomes the decided list can be held to.
  public enum Outcome: String, CaseIterable, Sendable {
    case approved, denied, expired
  }

  public let waiting: Page<Routes.Inbox>
  @Published public internal(set) var decided: [Routes.Decided] = []
  @Published public internal(set) var counts: Routes.Counts?
  /// More were decided than the list holds: another page can be read.
  @Published public private(set) var more = false
  @Published public private(set) var readingMore = false
  @Published public private(set) var decidedError: String?
  /// The outcome the decided list is held to; all of them with none.
  @Published public var outcome: Outcome?
  /// Words the decided list is held to.
  @Published public var words = ""
  /// The approvals being decided, so their buttons wait.
  @Published public private(set) var deciding: Set<Int> = []

  /// An ask to open, from its notification: the Inbox shows and opens it.
  @Published public private(set) var revealing: Int?
  @Published private var revealTries = 0

  /// Told when one is decided here, so the chat's card and the glance's row go too.
  public var settled: (String) -> Void = { _ in }

  /// How many decided a page reads, as the dashboard's Inbox does.
  public static let pageSize = 25

  private let dashboard: Dashboard
  private let haptics: Haptics
  private let say: (Toast) -> Void
  private var reads = 0

  public init(dashboard: Dashboard, haptics: Haptics, say: @escaping (Toast) -> Void) {
    self.dashboard = dashboard
    self.haptics = haptics
    self.say = say
    waiting = Page { try await dashboard.get(Routes.Inbox.self, "/api/inbox") }
  }

  /// Open this ask, from its notification.
  public func reveal(_ id: String) {
    revealing = Int(id)
  }

  /// The line is back: an ask still to reveal is read for again.
  public func lineUp() {
    if revealing != nil { revealTries += 1 }
  }

  /// What the screen opens the revealed ask on: a new one, or a new try once the line is back.
  public var revealKey: String? { revealing.map { "\($0)/\(revealTries)" } }

  /// The ask being revealed, read afresh. Off the line it is kept for the next try; settled meanwhile, it is said.
  public func revealed() async -> Routes.Pending? {
    guard let id = revealing else { return nil }
    await waiting.refresh()
    guard waiting.error == nil, revealing == id else { return nil }
    revealing = nil
    guard let ask = waiting.value?.approvals.first(where: { $0.id == id }) else {
      say(.init("That ask was already settled"))
      return nil
    }
    return ask
  }

  /// What waits, and the first page of what was decided, held as the owner holds it.
  public func refresh() async {
    async let pending: Void = waiting.refresh()
    async let history: Void = readDecided(after: nil)
    _ = await (pending, history)
  }

  /// What was decided, read again from its first page: the outcome or the words it is held to changed.
  public func refreshDecided() async {
    await readDecided(after: nil)
  }

  /// The next page of what was decided, after the last row shown.
  public func readMore() async {
    guard more, !readingMore, let last = decided.last else { return }
    await readDecided(after: last)
  }

  private func readDecided(after last: Routes.Decided?) async {
    reads += 1
    let read = reads
    var query = ["limit": String(Self.pageSize)]
    if let outcome { query["status"] = outcome.rawValue }
    let q = words.trimmingCharacters(in: .whitespacesAndNewlines)
    if !q.isEmpty { query["q"] = q }
    if let last { query["before"] = "\(Int(last.decidedAt ?? last.requestedAt)),\(last.id)" }
    let asked = query
    readingMore = last != nil
    defer { if read == reads { readingMore = false } }
    do {
      async let page = dashboard.get(Routes.List<Routes.Decided>.self, "/api/approvals/history", query: asked)
      async let tally: Routes.Counts? = last == nil ? dashboard.get(Routes.Counts.self, "/api/approvals/history/counts") : nil
      let (rows, total) = try await (page.items, tally)
      guard read == reads else { return }
      decided = last == nil ? rows : decided + rows
      more = rows.count == Self.pageSize
      if let total { counts = total }
      decidedError = nil
    } catch {
      guard read == reads else { return }
      decidedError = (error as? Dashboard.Refusal)?.message ?? error.localizedDescription
    }
  }

  /// The owner's decision on one waiting: felt, sent, and the row gone once KOS has it; said when it did not go.
  public func decide(_ ask: Routes.Pending, approved: Bool, remember: Bool = false) async {
    guard !deciding.contains(ask.id) else { return }
    deciding.insert(ask.id)
    defer { deciding.remove(ask.id) }
    if approved { haptics.done() } else { haptics.tap() }
    do {
      var body: [String: JSONValue] = ["id": .number(Double(ask.id))]
      if approved && remember { body["remember"] = .bool(true) }
      try await dashboard.post(approved ? "/api/approve" : "/api/deny", body: .object(body))
      waiting.edit { $0 = $0.without(ask.id) }
      settled(String(ask.id))
      await readDecided(after: nil)
    } catch {
      haptics.attention()
      say(.init("Couldn't \(approved ? "approve" : "deny") \(ask.tool). \((error as? Dashboard.Refusal)?.message ?? "")", tone: .warn))
    }
  }

  /// Decided elsewhere: no longer waiting here.
  public func settledElsewhere(_ id: String) {
    guard let number = Int(id) else { return }
    waiting.edit { $0 = $0.without(number) }
  }

  public func reset() {
    reads += 1
    waiting.reset()
    decided = []
    counts = nil
    more = false
    readingMore = false
    decidedError = nil
    deciding = []
  }
}

extension Routes.Inbox {
  /// The same, less one approval decided.
  func without(_ id: Int) -> Routes.Inbox {
    Routes.Inbox(approvals: approvals.filter { $0.id != id }, failures: failures)
  }

  public init(approvals: [Routes.Pending], failures: [Routes.Failing] = []) {
    self.approvals = approvals
    self.failures = failures
  }
}
