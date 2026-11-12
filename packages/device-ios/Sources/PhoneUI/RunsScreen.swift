import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// Runs: every schedule, each to run now or pause, then the runs lately,
/// newest first, each with how it went and how long it took.
struct RunsScreen: View {
  @ObservedObject var runs: RunsModel
  @ObservedObject private var crons: Page<[Routes.Cron]>
  @ObservedObject private var recent: Page<[Routes.Run]>
  var now: Date = Date()
  @Environment(\.dismiss) private var dismiss

  init(runs: RunsModel, now: Date = Date()) {
    self.runs = runs
    crons = runs.crons
    recent = runs.runs
    self.now = now
  }

  /// A job's name for a run of it, where the run names its job by id.
  private func name(_ run: Routes.Run) -> String {
    if run.kind == "cron", let ref = run.ref, let id = Int(ref), let job = crons.value?.first(where: { $0.id == id }) { return job.name }
    return run.ref.map { "\(run.kind) \($0)" } ?? run.kind
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Runs", detail: crons.value.map { "\($0.filter(\.enabled).count) of \($0.count) schedules on" }, back: { dismiss() })
    } content: {
      Loaded(page: crons, loading: "Reading the schedules") { jobs in
        PageList(refresh: runs.refresh) {
          if let error = crons.error ?? recent.error { StaleNote(error: error).pageRow(separator: false) }
          GroupHead(title: "Schedules", count: jobs.count).pageRow(separator: false)
          if jobs.isEmpty {
            Text("Nothing is scheduled. Ask KOS to do something every morning, say.").font(.kos(.dense)).foregroundStyle(Theme.muted)
              .padding(.bottom, 8).pageRow(separator: false)
          }
          ForEach(jobs.sorted { ($0.enabled ? 0 : 1, $0.nextRunAt ?? .infinity) < ($1.enabled ? 0 : 1, $1.nextRunAt ?? .infinity) }) { job in
            CronRow(job: job, runs: runs, now: now).pageRow()
          }
          GroupHead(title: "Lately", count: recent.value?.count).pageRow(separator: false)
          if let lately = recent.value {
            if lately.isEmpty { Text("Nothing has run yet.").font(.kos(.dense)).foregroundStyle(Theme.muted).pageRow(separator: false) }
            ForEach(lately) { run in RunRow(run: run, name: name(run), now: now).pageRow() }
          } else {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 12).pageRow(separator: false)
          }
        }
      }
    }
    .task {
      if crons.value == nil || recent.value == nil { await runs.refresh() }
    }
  }
}

/// One run: how it went, what ran, when and for how long, and the error when it failed.
struct RunRow: View {
  let run: Routes.Run
  let name: String
  let now: Date

  private var look: (symbol: String, tint: Color, word: String) {
    switch run.status {
    case "ok": ("checkmark", Theme.ok, "Done")
    case "running": ("bolt.fill", Theme.accent, "Running")
    case "skipped": ("forward", Theme.muted, "Skipped")
    default: ("xmark", Theme.danger, "Failed")
    }
  }

  var body: some View {
    let look = look
    let took = run.durationMs.map { RunWords.took($0) }
    PageRowLabel(
      symbol: look.symbol, tint: look.tint, title: name,
      detail: [look.word, ChatTime.relative(run.startedAt.at, now: now), took].compactMap { $0 }.joined(separator: " · ") + (run.error.map { "\n\($0)" } ?? ""),
      detailLines: run.error == nil ? 1 : 3)
  }
}

/// How long a run took, as a person says it.
enum RunWords {
  static func took(_ ms: Double) -> String {
    ms < 1000 ? "under a second" : elapsedWords(ms / 1000)
  }
}
