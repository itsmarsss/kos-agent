import DeviceCore
import Foundation

/// Runs, as the dashboard's: every schedule with whether it is on, running,
/// when it ran and when it runs next, and the runs lately, newest first. The
/// owner runs one now, or pauses and resumes it, as on the dashboard; a
/// blob's or a project's schedule is the same job, done from its own page.
@MainActor
public final class RunsModel: ObservableObject {
  public let crons: Page<[Routes.Cron]>
  public let runs: Page<[Routes.Run]>
  /// The jobs a press is on its way for, so their buttons wait.
  @Published public private(set) var busy: Set<Int> = []

  /// How many runs the page reads.
  public static let recent = 50

  private let dashboard: Dashboard
  private let haptics: Haptics
  private let say: (Toast) -> Void

  public init(dashboard: Dashboard, haptics: Haptics, say: @escaping (Toast) -> Void) {
    self.dashboard = dashboard
    self.haptics = haptics
    self.say = say
    crons = Page { try await dashboard.get(Routes.List<Routes.Cron>.self, "/api/crons").items }
    runs = Page { try await dashboard.get(Routes.List<Routes.Run>.self, "/api/runs", query: ["limit": String(Self.recent)]).items }
  }

  public func refresh() async {
    async let jobs: Void = crons.refresh()
    async let lately: Void = runs.refresh()
    _ = await (jobs, lately)
  }

  /// Runs the job now, whatever its schedule; it is said when it went, and the page is read again.
  public func runNow(id: Int, name: String) async {
    await act(id) {
      try await dashboard.post("/api/crons/run", body: .object(["id": .number(Double(id))]))
      say(.init("Running \(name)"))
    }
  }

  /// Pauses the job, or lets it run on its schedule again.
  public func setEnabled(id: Int, name: String, _ on: Bool) async {
    await act(id) {
      try await dashboard.post("/api/crons/enable", body: .object(["id": .number(Double(id)), "enabled": .bool(on)]))
      crons.edit { jobs in jobs = jobs.map { $0.id == id ? $0.with(enabled: on) : $0 } }
      say(.init(on ? "\(name) runs on its schedule again" : "\(name) is paused"))
    }
  }

  private func act(_ id: Int, _ work: () async throws -> Void) async {
    guard !busy.contains(id) else { return }
    busy.insert(id)
    defer { busy.remove(id) }
    haptics.tap()
    do {
      try await work()
      haptics.done()
      await refresh()
    } catch {
      haptics.attention()
      say(.init((error as? Dashboard.Refusal)?.message ?? error.localizedDescription, tone: .warn))
    }
  }

  public func reset() {
    crons.reset()
    runs.reset()
    busy = []
  }
}

extension Routes.Cron {
  /// The same job, on or paused.
  func with(enabled: Bool) -> Routes.Cron {
    Routes.Cron(
      id: id, name: name, schedule: schedule, type: type, enabled: enabled, projectSlug: projectSlug, running: running, lastRunAt: lastRunAt,
      nextRunAt: enabled ? nextRunAt : nil)
  }
}
