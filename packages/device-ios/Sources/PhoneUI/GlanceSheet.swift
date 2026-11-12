import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The glance: what KOS has on the go, what waits on the owner, what is
/// failing and what runs next, as KOS answered it. Pulled down, it asks again.
struct GlanceSheet: View {
  @ObservedObject var glance: GlanceModel
  var now: Date = Date()

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
          if report.waiting > 0 {
            section("Waiting on you", count: report.waiting, empty: "") {
              row(symbol: "hand.raised.fill", tint: Theme.warn, title: "\(report.waiting) waiting", detail: "Decide them here when their chat is shown, or on the dashboard.")
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
    .refreshable { glance.ask() }
    .background(Theme.panel)
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
