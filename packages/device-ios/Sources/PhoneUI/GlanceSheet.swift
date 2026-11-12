import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The glance: what KOS has on the go, what waits on the owner, what is
/// failing and what runs next, as KOS answered it. Pulled down, it asks again.
/// Each ask waiting is a row that opens it, to decide as in its own chat.
struct GlanceSheet: View {
  @ObservedObject var glance: GlanceModel
  var now: Date = Date()
  @State private var deciding: GlanceModel.Waiting?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        HStack(alignment: .firstTextBaseline) {
          Text("Glance").font(.kos(.title, .semibold))
          Spacer()
          if glance.asking {
            ProgressView().controlSize(.small)
          } else if let at = glance.at {
            Text(GlanceWords.updated(at, now: now)).font(.kos(.detail)).foregroundStyle(Theme.faint)
          }
        }
        if let report = glance.report {
          if report.halted {
            Card(tone: Theme.danger, wash: true) {
              RowText("KOS is halted", "The kill switch is on: nothing runs until it is let go on the dashboard.", size: .control)
            }
          }
          section("Running", count: report.running.count, empty: "Nothing is running.") {
            ForEach(report.running, id: \.id) { run in
              row(symbol: "bolt.fill", tint: Theme.accent, title: run.title, detail: "Working")
            }
          }
          if glance.waiting > 0 {
            section("Waiting on you", count: glance.waiting, empty: "") {
              ForEach(glance.asks) { waiting in
                Button { deciding = waiting } label: { askRow(waiting) }
                  .buttonStyle(.plain)
                  .accessibilityHint("Opens it to approve or deny")
              }
              if glance.waiting > glance.asks.count {
                Text(glance.asks.isEmpty ? "\(glance.waiting) waiting. Pull down to see them." : "\(glance.waiting - glance.asks.count) more after these.")
                  .font(.kos(.detail))
                  .foregroundStyle(Theme.muted)
              }
            }
          }
          section("Failing", count: report.failing.count, empty: "Nothing is failing.") {
            ForEach(Array(report.failing.enumerated()), id: \.offset) { _, job in
              row(
                symbol: "exclamationmark.triangle.fill", tint: Theme.danger, title: job.label,
                detail: "\(GlanceWords.streak(job.streak)), \(GlanceWords.failingFor(since: Date(timeIntervalSince1970: job.since / 1000), now: now))",
                note: job.error)
            }
          }
          section("Next", count: report.next.count, empty: "Nothing is scheduled.") {
            ForEach(Array(report.next.enumerated()), id: \.offset) { _, next in
              row(symbol: "clock", tint: Theme.violet, title: next.name, detail: GlanceWords.next(Date(timeIntervalSince1970: next.at / 1000), now: now))
            }
          }
        } else {
          Text(glance.asking ? "Asking KOS…" : "KOS has not said yet.").font(.kos(.dense)).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 24)
      .padding(.bottom, 20)
    }
    // Scrolled to its end, the last row clears the home indicator.
    .contentMargins(.bottom, 16, for: .scrollContent)
    .refreshable { glance.ask() }
    .background(Theme.panel)
    .sheet(item: $deciding) { waiting in
      AskBody(ask: waiting.ask, more: 0, from: waiting.chat) { approved, remember in
        glance.answer(waiting.id, approved: approved, remember: remember)
        deciding = nil
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Theme.panel)
      .presentationDetents([.medium, .large])
    }
  }

  /// One ask: what KOS would run, why, and the chat it is for with the time it has left.
  private func askRow(_ waiting: GlanceModel.Waiting) -> some View {
    let ask = waiting.ask
    let lapse = ask.expires.map { GlanceWords.lapses($0, now: now) }
    let foot = [waiting.chat, lapse].compactMap { $0 }.joined(separator: ", ")
    return HStack(alignment: .top, spacing: 12) {
      Tile("hand.raised.fill", tint: Theme.warn)
      VStack(alignment: .leading, spacing: 4) {
        RowText(ask.tool, ask.why ?? ask.reason, size: .control, titleLines: 1, detailLines: 2)
        if !foot.isEmpty {
          Text(foot).font(.kos(.small)).foregroundStyle(Theme.faint).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right").font(.kos(.detail, .semibold)).foregroundStyle(Theme.faint).padding(.top, 2)
    }
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func section<Rows: View>(_ title: String, count: Int, empty: String, @ViewBuilder rows: () -> Rows) -> some View {
    KOSSection(title, trailing: {
      if count > 0 { Text("\(count)").font(.kos(.tiny, .semibold).monospacedDigit()).foregroundStyle(Theme.faint) }
    }) {
      if count == 0 {
        Text(empty).font(.kos(.dense)).foregroundStyle(Theme.muted)
      } else {
        Card(padding: EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12), spacing: 12) { rows() }
      }
    }
  }

  private func row(symbol: String, tint: Color, title: String, detail: String, note: String? = nil) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Tile(symbol, tint: tint)
      VStack(alignment: .leading, spacing: 4) {
        RowText(title, detail, size: .control, titleLines: 2, detailLines: 2)
        if let note {
          Text(note).font(.kos(.small, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(3)
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}
