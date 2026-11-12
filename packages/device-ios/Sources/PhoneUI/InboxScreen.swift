import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The Inbox, as the dashboard's: what waits on the owner first, each row
/// opening the ask to read and decide, a swipe right to approve and left to
/// deny, a long press for both and the remembered yes; the jobs failing
/// under it; then what was decided, held to an outcome or searched, a page
/// at a time as the list is scrolled.
struct InboxScreen: View {
  @ObservedObject var inbox: InboxModel
  @ObservedObject private var waiting: Page<Routes.Inbox>
  var now: Date = Date()
  @State private var open: Routes.Pending?

  init(inbox: InboxModel, now: Date = Date()) {
    self.inbox = inbox
    waiting = inbox.waiting
    self.now = now
  }

  private var detail: String {
    guard let count = waiting.value?.approvals.count else { return "What waits on you" }
    return count == 0 ? "Nothing waiting" : "\(count) waiting on you"
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Inbox", detail: detail)
    } content: {
      Loaded(page: waiting, loading: "Reading your inbox") { value in
        PageList(refresh: inbox.refresh) {
          if let error = waiting.error { StaleNote(error: error).pageRow(separator: false) }
          pending(value.approvals)
          if !value.failures.isEmpty { failing(value.failures) }
          decided
        }
      }
    }
    .task { if waiting.value == nil { await inbox.refresh() } }
    .task(id: inbox.words) {
      // Typed words settle before the decided list is read again.
      guard waiting.value != nil else { return }
      try? await Task.sleep(for: .milliseconds(350))
      if !Task.isCancelled { await inbox.refreshDecided() }
    }
    .sheet(item: $open) { ask in
      AskBody(ask: ask.ask, more: 0, from: ask.asker) { approved, remember in
        open = nil
        Task { await inbox.decide(ask, approved: approved, remember: remember) }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Theme.panel)
      .presentationBackground(Theme.panel)
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
    }
  }

  @ViewBuilder
  private func pending(_ asks: [Routes.Pending]) -> some View {
    GroupHead(title: "Waiting on you", count: asks.isEmpty ? nil : asks.count).pageRow(separator: false)
    if asks.isEmpty {
      Text("Nothing is waiting on you. KOS asks here before it does anything you said it should ask about.")
        .font(.kos(.dense)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        .padding(.bottom, 8)
        .pageRow(separator: false)
    }
    ForEach(asks) { ask in
      Button { open = ask } label: { AskRow(ask: ask, now: now, busy: inbox.deciding.contains(ask.id)) }
        .buttonStyle(.plain)
        .disabled(inbox.deciding.contains(ask.id))
        .accessibilityHint("Opens it to approve or deny")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
          Button { decide(ask, true) } label: { Label("Approve", systemImage: "checkmark") }.tint(Theme.ok)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          Button(role: .destructive) { decide(ask, false) } label: { Label("Deny", systemImage: "xmark") }.tint(Theme.danger)
        }
        .contextMenu {
          Button { decide(ask, true) } label: { Label("Approve", systemImage: "checkmark") }
          if let always = ask.always {
            Button { decide(ask, true, remember: true) } label: { Label(always, systemImage: "checkmark.seal") }
          }
          Button(role: .destructive) { decide(ask, false) } label: { Label("Deny", systemImage: "xmark") }
        }
        .pageRow()
    }
  }

  private func decide(_ ask: Routes.Pending, _ approved: Bool, remember: Bool = false) {
    Task { await inbox.decide(ask, approved: approved, remember: remember) }
  }

  @ViewBuilder
  private func failing(_ jobs: [Routes.Failing]) -> some View {
    GroupHead(title: "Failing", count: jobs.count).pageRow(separator: false)
    ForEach(jobs, id: \.key) { job in
      PageRowLabel(
        symbol: "exclamationmark.triangle.fill", tint: Theme.danger, title: job.label,
        detail: [GlanceWords.streak(job.streak), job.error].compactMap { $0 }.joined(separator: ": "), detailLines: 2)
        .pageRow()
    }
  }

  @ViewBuilder
  private var decided: some View {
    GroupHead(title: "Decided", count: inbox.counts.map { $0.approved + $0.denied + $0.expired }).pageRow(separator: false)
    VStack(spacing: 4) {
      SearchField(prompt: "Search what was decided", text: $inbox.words)
      FilterChips(options: outcomes, selected: inbox.outcome) { outcome in
        inbox.outcome = outcome
        Task { await inbox.refreshDecided() }
      }
      .padding(.horizontal, -16)
    }
    .padding(.bottom, 4)
    .pageRow(separator: false)
    if let error = inbox.decidedError {
      PageNote(kind: .failed(error, retry: inbox.refreshDecided)).pageRow(separator: false)
    } else if inbox.decided.isEmpty {
      Text(inbox.words.isEmpty && inbox.outcome == nil ? "Nothing decided yet." : "Nothing decided matches.")
        .font(.kos(.dense)).foregroundStyle(Theme.muted)
        .padding(.vertical, 12)
        .pageRow(separator: false)
    }
    ForEach(inbox.decided) { row in
      DecidedRow(row: row, now: now)
        .onAppear { if row.id == inbox.decided.last?.id { Task { await inbox.readMore() } } }
        .pageRow()
    }
    if inbox.readingMore {
      ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 12).pageRow(separator: false)
    }
  }

  private var outcomes: [(value: InboxModel.Outcome?, label: String)] {
    let counts = inbox.counts
    let label = { (word: String, count: Int?) in count.map { "\(word) \($0)" } ?? word }
    return [
      (nil, "All"), (.approved, label("Approved", counts?.approved)), (.denied, label("Denied", counts?.denied)),
      (.expired, label("Lapsed", counts?.expired)),
    ]
  }
}

/// One ask waiting: what KOS would do, who asks, how long it has, and why.
struct AskRow: View {
  let ask: Routes.Pending
  let now: Date
  var busy = false

  private var foot: String {
    [ask.asker, ask.expiresAt.map { GlanceWords.lapses($0.at, now: now) }].compactMap { $0 }.joined(separator: " · ")
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Tile("hand.raised.fill", tint: Theme.warn)
      VStack(alignment: .leading, spacing: 3) {
        Text(ask.summary ?? ask.tool).font(.kos(.body, .semibold)).foregroundStyle(Theme.text).lineLimit(2)
        if let why = ask.why ?? ask.reason {
          Text(why).font(.kos(.small)).foregroundStyle(Theme.muted).lineLimit(2)
        }
        if !foot.isEmpty { Text(foot).font(.kos(.tiny)).foregroundStyle(Theme.faint).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if busy {
        ProgressView().controlSize(.small).frame(width: 20, height: 20)
      } else {
        Image(systemName: "chevron.right").font(.kos(.detail, .semibold)).foregroundStyle(Theme.faint).padding(.top, 4)
      }
    }
    .padding(.vertical, 12)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// One already decided, in words: how it went, who asked, and when.
struct DecidedRow: View {
  let row: Routes.Decided
  let now: Date

  private var look: (symbol: String, tint: Color, word: String) {
    switch row.status {
    case "approved": ("checkmark", Theme.ok, "Approved")
    case "denied": ("xmark", Theme.danger, "Denied")
    default: ("clock", Theme.muted, "Lapsed")
    }
  }

  var body: some View {
    let look = look
    let when = ChatTime.relative((row.decidedAt ?? row.requestedAt).at, now: now)
    PageRowLabel(symbol: look.symbol, tint: look.tint, title: row.summary, detail: [look.word, row.asker, when].compactMap { $0 }.joined(separator: " · "))
  }
}

extension Routes.Pending {
  /// The ask as the chat's card holds it, to decide in the same sheet.
  var ask: ChatModel.Ask {
    .init(
      id: String(id), tool: tool, summary: summary, args: args, mechanics: mechanics, why: why, reason: reason, always: always, expires: expiresAt?.at,
      chat: conversationId)
  }
}
