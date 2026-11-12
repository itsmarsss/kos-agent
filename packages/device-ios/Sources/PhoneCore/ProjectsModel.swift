import DeviceCore
import Foundation

/// Projects, as the dashboard lists them, the latest touched first, and one
/// project's page: its chats, its artifacts, its tables and its schedules
/// (`/api/projects/<slug>/detail`).
@MainActor
public final class ProjectsModel: ObservableObject {
  public let list: Page<[Routes.Project]>
  private let dashboard: Dashboard
  private var pages: [String: Page<Routes.ProjectDetail>] = [:]

  public init(dashboard: Dashboard) {
    self.dashboard = dashboard
    list = Page {
      try await dashboard.get(Routes.List<Routes.Project>.self, "/api/projects").items.sorted { $0.lastTouchedAt > $1.lastTouchedAt }
    }
  }

  /// One project's page, kept while the app runs so going back and in again shows it at once.
  public func page(_ slug: String) -> Page<Routes.ProjectDetail> {
    if let page = pages[slug] { return page }
    let dashboard = dashboard
    let page = Page { try await dashboard.get(Routes.ProjectDetail.self, "/api/projects/\(slug)/detail") }
    pages[slug] = page
    return page
  }

  public func reset() {
    list.reset()
    pages = [:]
  }
}
