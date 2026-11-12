import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The Projects tab: every project, the latest touched first, searched by
/// name, each opening its page.
struct ProjectsScreen: View {
  @ObservedObject var projects: ProjectsModel
  @ObservedObject private var list: Page<[Routes.Project]>
  var now: Date = Date()
  @State private var words = ""
  @Environment(\.go) private var go

  init(projects: ProjectsModel, now: Date = Date()) {
    self.projects = projects
    list = projects.list
    self.now = now
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Projects", detail: list.value.map { $0.count == 1 ? "1 project" : "\($0.count) projects" })
    } content: {
      Loaded(page: list, loading: "Reading your projects") { all in
        let shown = all.filter { words.isEmpty || "\($0.name) \($0.description ?? "")".localizedCaseInsensitiveContains(words) }
        PageList(refresh: list.refresh) {
          if let error = list.error { StaleNote(error: error).pageRow(separator: false) }
          if all.count > 6 {
            SearchField(prompt: "Search projects", text: $words).padding(.vertical, 12).pageRow(separator: false)
          }
          if all.isEmpty {
            PageNote(kind: .empty(symbol: "folder", title: "No projects yet", detail: "Ask KOS to set one up: a budget, a plan, a tracker."))
              .pageRow(separator: false)
          } else if shown.isEmpty {
            PageNote(kind: .empty(symbol: "magnifyingglass", title: "Nothing matches", detail: "Try other words.")).pageRow(separator: false)
          }
          ForEach(shown) { project in
            Button { go(.project(slug: project.slug, name: project.name)) } label: { ProjectRow(project: project, now: now) }
              .buttonStyle(.plain)
              .pageRow()
          }
        }
      }
    }
    .task { await list.ensure() }
  }
}

/// One project: its colour's tile, its name, what it is and how much it holds, when it was touched, and its state
/// unless it is active.
struct ProjectRow: View {
  let project: Routes.Project
  let now: Date

  private var detail: String {
    let tables = project.tableCount.map { $0 == 1 ? "1 table" : "\($0) tables" }
    return [project.type?.capitalized, tables, ChatTime.relative(project.lastTouchedAt.at, now: now)].compactMap { $0 }.joined(separator: " · ")
  }

  var body: some View {
    PageRowLabel(symbol: "folder.fill", tint: ProjectTint.of(project), title: project.name, detail: detail, opens: true) {
      if project.status != "active" { Pill(project.status.capitalized, tone: .muted) }
    }
  }
}

/// A project's colour: the owner's, else the accent.
enum ProjectTint {
  static func of(_ project: Routes.Project) -> Color {
    guard let hex = project.colour?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), hex.count == 6, let value = UInt32(hex, radix: 16) else {
      return Theme.accent
    }
    return Color(hex: value)
  }
}

/// One project's page: its chats (each read at a tap), its artifacts, its tables with how much each holds, its
/// schedules to run now or pause, and its folder.
struct ProjectScreen: View {
  let slug: String
  let name: String
  @ObservedObject var page: Page<Routes.ProjectDetail>
  @ObservedObject var runs: RunsModel
  let shelf: ArtifactShelf
  var now: Date = Date()
  @Environment(\.go) private var go
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    PageFrame {
      PageHead(title: page.value?.project.name ?? name, detail: page.value.map(summary), back: { dismiss() })
    } content: {
      Loaded(page: page, loading: "Reading \(name)") { detail in
        PageList(refresh: page.refresh) {
          if let error = page.error { StaleNote(error: error).pageRow(separator: false) }
          if let description = detail.project.description, !description.isEmpty {
            Text(description).font(.kos(.dense)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
              .padding(.top, 14)
              .pageRow(separator: false)
          }
          chats(detail.agents)
          artifacts(detail.pages.filter(\.opens))
          tables(detail.tables)
          schedules(detail.crons)
          GroupHead(title: "Files").pageRow(separator: false)
          Button { go(.folder(path: detail.folder)) } label: {
            PageRowLabel(symbol: "folder", tint: Theme.muted, title: "Open the folder", detail: detail.folder, opens: true)
          }
          .buttonStyle(.plain)
          .pageRow()
        }
      }
    }
    .task { await page.ensure() }
  }

  private func summary(_ detail: Routes.ProjectDetail) -> String {
    [detail.project.type?.capitalized, detail.project.status == "active" ? nil : detail.project.status.capitalized].compactMap { $0 }.joined(separator: " · ")
  }

  @ViewBuilder
  private func chats(_ chats: [Routes.Chat]) -> some View {
    GroupHead(title: "Chats", count: chats.count).pageRow(separator: false)
    if chats.isEmpty { quiet("No chats under it yet.") }
    ForEach(chats.sorted { $0.updatedAt > $1.updatedAt }) { chat in
      Button { go(.chat(id: chat.id, title: chat.title)) } label: { ChatRow(chat: chat, now: now) }
        .buttonStyle(.plain)
        .pageRow()
    }
  }

  @ViewBuilder
  private func artifacts(_ items: [Routes.Artifact]) -> some View {
    GroupHead(title: "Artifacts", count: items.count).pageRow(separator: false)
    if items.isEmpty { quiet("Nothing made in it yet.") }
    ForEach(items.sorted { $0.updatedAt > $1.updatedAt }) { item in
      ArtifactListRow(item: item, now: now) { shelf.open(item.id, title: item.title, dark: scheme == .dark) }.pageRow()
    }
  }

  @ViewBuilder
  private func tables(_ tables: [Routes.Table]) -> some View {
    GroupHead(title: "Tables", count: tables.count).pageRow(separator: false)
    if tables.isEmpty { quiet("No tables yet.") }
    ForEach(tables, id: \.name) { table in
      PageRowLabel(symbol: "tablecells", tint: Theme.accent, title: table.name, detail: TableWords.size(table)).pageRow()
    }
  }

  @ViewBuilder
  private func schedules(_ crons: [Routes.Cron]) -> some View {
    if !crons.isEmpty {
      GroupHead(title: "Schedules", count: crons.count).pageRow(separator: false)
      ForEach(crons) { job in CronRow(job: job, runs: runs, now: now).pageRow() }
    }
  }

  private func quiet(_ words: String) -> some View {
    Text(words).font(.kos(.dense)).foregroundStyle(Theme.muted).padding(.bottom, 8).pageRow(separator: false)
  }
}

/// How much a table holds, said plainly.
enum TableWords {
  static func size(_ table: Routes.Table) -> String {
    let rows = table.rows < 0 ? "Could not be counted" : table.rows == 1 ? "1 row" : "\(table.rows) rows"
    return "\(rows) · \(table.columns == 1 ? "1 column" : "\(table.columns) columns")"
  }
}

/// A chat in a list: what it is doing, its title, and when it last moved.
struct ChatRow: View {
  let chat: Routes.Chat
  let now: Date

  private var look: (symbol: String, tint: Color, word: String?) {
    switch chat.activity {
    case "working": ("bolt.fill", Theme.accent, "Working")
    case "needs-you": ("hand.raised.fill", Theme.warn, "Waiting on you")
    case "error": ("exclamationmark.triangle.fill", Theme.danger, "Its last turn failed")
    default: ("bubble.left", Theme.muted, nil)
    }
  }

  var body: some View {
    let look = look
    PageRowLabel(symbol: look.symbol, tint: look.tint, title: chat.title, detail: [look.word, ChatTime.relative(chat.updatedAt.at, now: now)].compactMap { $0 }.joined(separator: " · "), opens: true) {
      if chat.unread == true { Dot(Theme.accent, size: 8).accessibilityLabel("Unread") }
    }
  }
}

/// A schedule in a list: whether it is on, running or paused, when it runs next or ran last, and its cron line;
/// Pause or Resume and Run now at its right, one height, and on a swipe and a long press too, as on the dashboard.
struct CronRow: View {
  let job: Routes.Cron
  @ObservedObject var runs: RunsModel
  let now: Date

  /// The height Pause and Run now share.
  static let control: CGFloat = 34

  private var state: (symbol: String, tint: Color, words: String) {
    if job.running == true { return ("bolt.fill", Theme.accent, "Running now") }
    if !job.enabled { return ("pause.fill", Theme.muted, "Paused") }
    if let next = job.nextRunAt { return ("clock", Theme.violet, "Next \(GlanceWords.next(next.at, now: now))") }
    return ("clock", Theme.muted, "On")
  }

  var body: some View {
    let state = state
    let busy = runs.busy.contains(job.id)
    HStack(spacing: 12) {
      Tile(state.symbol, tint: state.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(job.name).font(.kos(.body, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
        Text([state.words, job.lastRunAt.map { "ran \(ChatTime.relative($0.at, now: now))" }].compactMap { $0 }.joined(separator: " · "))
          .font(.kos(.small)).foregroundStyle(Theme.muted).lineLimit(1)
        Text(job.schedule).font(.kos(.tiny, design: .monospaced)).foregroundStyle(Theme.faint).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if busy {
        ProgressView().controlSize(.small).frame(width: 44, height: 44)
      } else {
        Button { Task { await runs.setEnabled(id: job.id, name: job.name, !job.enabled) } } label: {
          Text(job.enabled ? "Pause" : "Resume").font(.kos(.dense, .semibold)).foregroundStyle(Theme.text)
            .padding(.horizontal, 12)
            .frame(height: Self.control)
            .background(Theme.panel2, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.line))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(job.enabled ? "Pause" : "Resume") \(job.name)")
        Button { Task { await runs.runNow(id: job.id, name: job.name) } } label: {
          Image(systemName: "play.fill").font(.kos(.dense, .semibold)).foregroundStyle(Theme.accent)
            .frame(width: Self.control, height: Self.control)
            .background(Theme.accent.opacity(Theme.tint), in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(job.running == true)
        .accessibilityLabel("Run \(job.name) now")
      }
    }
    .padding(.vertical, 10)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button { Task { await runs.setEnabled(id: job.id, name: job.name, !job.enabled) } } label: {
        Label(job.enabled ? "Pause" : "Resume", systemImage: job.enabled ? "pause" : "play")
      }
      .tint(job.enabled ? Theme.warn : Theme.ok)
    }
    .contextMenu {
      Button { Task { await runs.runNow(id: job.id, name: job.name) } } label: { Label("Run now", systemImage: "play") }
      Button { Task { await runs.setEnabled(id: job.id, name: job.name, !job.enabled) } } label: {
        Label(job.enabled ? "Pause" : "Resume", systemImage: job.enabled ? "pause" : "play.circle")
      }
    }
    .accessibilityElement(children: .contain)
  }
}
