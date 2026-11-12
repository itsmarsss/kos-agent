import DeviceCore
import Foundation

/// Blobs, as the dashboard's page lists them: each standing helper with what
/// it is up to, and one blob's page with its own chat read, its schedule and
/// what it made.
@MainActor
public final class BlobsModel: ObservableObject {
  public let list: Page<[Routes.Blob]>
  private let dashboard: Dashboard
  private var chats: [String: Page<Routes.Transcript>] = [:]

  public init(dashboard: Dashboard) {
    self.dashboard = dashboard
    list = Page { try await dashboard.get(Routes.Blobs.self, "/api/agents").agents.sorted { ($0.thread?.updatedAt ?? 0) > ($1.thread?.updatedAt ?? 0) } }
  }

  /// A chat's words, read, by its id: a blob's own thread or one of a project's.
  public func chat(_ id: String) -> Page<Routes.Transcript> {
    if let page = chats[id] { return page }
    let dashboard = dashboard
    let page = Page { try await dashboard.get(Routes.Transcript.self, "/api/conversations/\(id)/messages") }
    chats[id] = page
    return page
  }

  public func reset() {
    list.reset()
    chats = [:]
  }
}
