import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The overview: the glance, grown to the dashboard's first page. What waits
/// on the owner (decided here, or all of it in the Inbox), what runs now,
/// what is failing, how the last runs went, what runs next, the projects
/// touched last and what the week cost. Pulled, it asks KOS again.
struct OverviewScreen: View {
  @ObservedObject var overview: OverviewModel
  @ObservedObject private var home: Page<Routes.Home>
  @ObservedObject var glance: GlanceModel
  var now: Date = Date()
  @State private var deciding: GlanceModel.Waiting?
  @Environment(\.go) private var go
  @Environment(\.showTab) private var showTab
  @Environment(\.dismiss) private var dismiss

  init(overview: OverviewModel, glance: GlanceModel, now: Date = Date()) {
    self.overview = overview
    home = overview.home
    self.glance = glance
    self.now = now
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Overview", detail: glance.at.map { GlanceWords.updated($0, now: now) }, back: { dismiss() })
    } content: {
      Loaded(page: home, loading: "Asking KOS") { home in
        PageList(refresh: refresh) {
          if let error = self.home.error { StaleNote(error: error).pageRow(separator: false) }
          if glance.report?.halted == true {
            Card(tone: Theme.danger, wash: true) {
              RowText("KOS is halted", "The kill switch is on: nothing runs until it is let go on the dashboard.", size: .control)
            }
            .padding(.top, 14)
            .pageRow(separator: false)
          }
          tiles(home).padding(.top, 14).pageRow(separator: false)
          waiting
          running
          failing(home.health.failing)
          lately(home)
          next(home.upcoming)
          projects(home.projects)
        }
      }
    }
    .task {
      await home.ensure()
      if glance.report == nil { glance.ask() }
    }
    .sheet(item: $deciding) { waiting in
      AskBody(ask: waiting.ask, more: 0, from: waiting.chat) { approved, remember in
        glance.answer(waiting.id, approved: approved, remember: remember)
        deciding = nil
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Theme.panel)
      .presentationBackground(Theme.panel)
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
    }
  }

  private func refresh() async {
    glance.ask()
    await home.refresh()
  }

  /// Four figures at the top, two by two, each one height.
  private func tiles(_ home: Routes.Home) -> some View {
    let cost = OverviewModel.cost(home.spend)
    let calls = (home.spend?.models ?? []).reduce(0) { $0 + $1.calls }
    return Grid(horizontalSpacing: 10, verticalSpacing: 10) {
      GridRow {
        Figure(value: "\(glance.report != nil ? glance.waiting : home.approvals.count)", label: "Waiting on you", tint: Theme.warn)
        Figure(value: "\(glance.report?.running.count ?? 0)", label: "Running now", tint: Theme.accent)
      }
      GridRow {
        Figure(value: "\(home.health.failing.count)", label: "Failing", tint: home.health.failing.isEmpty ? Theme.ok : Theme.danger)
        Figure(value: cost.map { String(format: "$%.2f", $0) } ?? "\(calls)", label: cost == nil ? "Model calls this week" : "Spent this week", tint: Theme.violet)
      }
    }
  }

  @ViewBuilder
  private var waiting: some View {
    if glance.waiting > 0 {
      GroupHead(title: "Waiting on you", count: glance.waiting).pageRow(separator: false)
      ForEach(glance.asks.prefix(3)) { waiting in
        Button { deciding = waiting } label: {
          PageRowLabel(
            symbol: "hand.raised.fill", tint: Theme.warn, title: waiting.ask.summary ?? waiting.ask.tool,
            detail: [waiting.ask.why ?? waiting.ask.reason, waiting.chat].compactMap { $0 }.joined(separator: " · "), detailLines: 2, opens: true)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens it to approve or deny")
        .pageRow()
      }
      Button { showTab(.inbox) } label: {
        Text("See everything waiting in the Inbox").font(.kos(.dense, .semibold)).foregroundStyle(Theme.accent).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      }
      .buttonStyle(.plain)
      .pageRow()
    }
  }

  @ViewBuilder
  private var running: some View {
    if let report = glance.report, !report.running.isEmpty {
      GroupHead(title: "Running", count: report.running.count).pageRow(separator: false)
      ForEach(report.running, id: \.id) { run in
        PageRowLabel(symbol: "bolt.fill", tint: Theme.accent, title: run.title, detail: "Working").pageRow()
      }
    }
  }

  @ViewBuilder
  private func failing(_ jobs: [Routes.Failing]) -> some View {
    if !jobs.isEmpty {
      GroupHead(title: "Failing", count: jobs.count).pageRow(separator: false)
      ForEach(jobs, id: \.key) { job in
        PageRowLabel(
          symbol: "exclamationmark.triangle.fill", tint: Theme.danger, title: job.label,
          detail: "\(GlanceWords.streak(job.streak)), \(GlanceWords.failingFor(since: job.since.at, now: now))" + (job.error.map { "\n\($0)" } ?? ""),
          detailLines: job.error == nil ? 1 : 3)
          .pageRow()
      }
    }
  }

  @ViewBuilder
  private func lately(_ home: Routes.Home) -> some View {
    let strip = OverviewModel.strip(home.runs)
    if !strip.isEmpty {
      GroupHead(title: "Last runs").pageRow(separator: false)
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 3) {
          ForEach(strip) { run in
            Capsule().fill(RunTint.of(run.status)).frame(maxWidth: 10, minHeight: 22, maxHeight: 22)
          }
        }
        .accessibilityHidden(true)
        Text(home.health.recent.errors == 0 ? "All of the last \(home.health.recent.total) went through." : "\(home.health.recent.errors) of the last \(home.health.recent.total) failed.")
          .font(.kos(.dense)).foregroundStyle(Theme.muted)
        Button { go(.runs) } label: {
          Text("See every run").font(.kos(.dense, .semibold)).foregroundStyle(Theme.accent).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.plain)
      }
      .pageRow()
    }
  }

  @ViewBuilder
  private func next(_ upcoming: [Routes.Home.Upcoming]) -> some View {
    GroupHead(title: "Next", count: upcoming.isEmpty ? nil : upcoming.count).pageRow(separator: false)
    if upcoming.isEmpty {
      Text("Nothing runs in the next day.").font(.kos(.dense)).foregroundStyle(Theme.muted).padding(.bottom, 8).pageRow(separator: false)
    }
    ForEach(upcoming.prefix(5), id: \.id) { run in
      PageRowLabel(symbol: "clock", tint: Theme.violet, title: run.name, detail: GlanceWords.next(run.at.at, now: now)).pageRow()
    }
  }

  @ViewBuilder
  private func projects(_ projects: [Routes.Project]) -> some View {
    if !projects.isEmpty {
      GroupHead(title: "Projects lately").pageRow(separator: false)
      ForEach(projects.sorted { $0.lastTouchedAt > $1.lastTouchedAt }.prefix(4)) { project in
        Button { go(.project(slug: project.slug, name: project.name)) } label: { ProjectRow(project: project, now: now) }
          .buttonStyle(.plain)
          .pageRow()
      }
    }
  }
}

/// A figure on the overview: the number, and what it counts, in its tone.
private struct Figure: View {
  let value: String
  let label: String
  let tint: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(value).font(.kos(.title, .semibold).monospacedDigit()).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7)
      Text(label).font(.kos(.small)).foregroundStyle(Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
    }
    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).strokeBorder(Theme.line))
    .accessibilityElement(children: .combine)
  }
}

/// A run's status as a colour.
enum RunTint {
  static func of(_ status: String) -> Color {
    switch status {
    case "ok": Theme.ok
    case "running": Theme.accent
    case "skipped": Theme.lineStrong
    default: Theme.danger
    }
  }
}
