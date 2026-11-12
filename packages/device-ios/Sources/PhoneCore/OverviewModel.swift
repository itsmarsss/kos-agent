import DeviceCore
import Foundation

/// The overview, as the dashboard's first page answers it, for the phone:
/// what waits on the owner, what is failing, how the last runs went, what
/// runs next, the projects and chats touched last, and what the week cost.
/// The glance's live parts (halted, running) come from the glance itself.
@MainActor
public final class OverviewModel: ObservableObject {
  public let home: Page<Routes.Home>

  public init(dashboard: Dashboard) {
    home = Page { try await dashboard.get(Routes.Home.self, "/api/home") }
  }

  /// The last runs as a strip, oldest first, so it reads left to right as time does.
  public static func strip(_ runs: [Routes.Run], most: Int = 30) -> [Routes.Run] {
    Array(runs.prefix(most).reversed())
  }

  /// What the week cost, when any model has a rate set.
  public static func cost(_ spend: Routes.Home.Spend?) -> Double? {
    let costs = (spend?.models ?? []).compactMap(\.cost)
    return costs.isEmpty ? nil : costs.reduce(0, +)
  }

  public func reset() {
    home.reset()
  }
}
