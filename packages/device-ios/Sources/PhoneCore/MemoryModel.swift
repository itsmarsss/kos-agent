import DeviceCore
import Foundation

/// What KOS knows, as the dashboard's Memory: every claim, pinned first,
/// searched by its key, its words and its tags, and one claim's history.
/// Read only: what KOS knows is changed in a chat or on the dashboard.
@MainActor
public final class MemoryModel: ObservableObject {
  public let claims: Page<[Routes.Claim]>
  @Published public var words = ""
  @Published public var tag: String?
  private let dashboard: Dashboard
  private var traces: [String: Page<Routes.Trace>] = [:]

  /// The most the page reads: the dashboard's own cap on the list.
  public static let most = 1000

  public init(dashboard: Dashboard) {
    self.dashboard = dashboard
    claims = Page {
      try await dashboard.get(Routes.Memory.self, "/api/memory", query: ["limit": String(Self.most)]).facts
        .sorted { ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt) }
    }
  }

  /// The tags the claims carry, the most used first.
  public var tags: [String] {
    let counted = (claims.value ?? []).flatMap(\.tags).reduce(into: [String: Int]()) { $0[$1, default: 0] += 1 }
    return counted.sorted { ($0.value, $1.key) > ($1.value, $0.key) }.map(\.key)
  }

  public var shown: [Routes.Claim] { Self.held(claims.value ?? [], words: words, tag: tag) }

  static func held(_ claims: [Routes.Claim], words: String, tag: String?) -> [Routes.Claim] {
    let terms = words.lowercased().split(whereSeparator: \.isWhitespace)
    return claims.filter { claim in
      guard tag == nil || claim.tags.contains(tag!) else { return false }
      let text = "\(claim.key) \(claim.value) \(claim.tags.joined(separator: " "))".lowercased()
      return terms.allSatisfy { text.contains($0) }
    }
  }

  /// What a claim replaced, newest first, and the words it was drawn from.
  public func trace(_ key: String) -> Page<Routes.Trace> {
    if let page = traces[key] { return page }
    let dashboard = dashboard
    let page = Page { try await dashboard.get(Routes.Trace.self, "/api/memory/trace", query: ["key": key]) }
    traces[key] = page
    return page
  }

  public func reset() {
    claims.reset()
    words = ""
    tag = nil
    traces = [:]
  }
}
