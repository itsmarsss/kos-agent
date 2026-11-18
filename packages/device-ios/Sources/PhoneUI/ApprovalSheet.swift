import DeviceKit
import SwiftUI

/// What waits on the owner, decided in one tap: what KOS wants to do and
/// where, every step it takes, why, and when it lapses; Approve, the
/// remembered yes when one may be, and Deny for the thumb. The arguments fold
/// away under Details. Several waiting, the oldest first.
struct ApprovalSheet: View {
  @ObservedObject var chat: ChatModel
  let close: () -> Void

  var body: some View {
    Group {
      if let ask = chat.asks.first {
        AskBody(ask: ask, more: chat.asks.count - 1) { approved, remember in
          chat.answer(ask.id, approved: approved, remember: remember)
          if chat.asks.isEmpty { close() }
        }
        .id(ask.id)
      } else {
        VStack(spacing: 10) {
          Text("Nothing is waiting on you").font(.kos(.title, .semibold))
          Button("Done", action: close).buttonStyle(KOSButtonStyle(.secondary, large: true))
        }
        .padding(24)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Theme.panel)
  }
}

/// One ask, as the sheet lays it out: the dashboard's card (`AskSummary`, `AskDetails`) under who asks, then how
/// long it has and the buttons for the thumb, full width, Approve first.
struct AskBody: View {
  let ask: ChatModel.Ask
  /// How many more wait after this one.
  let more: Int
  /// The chat it is for, when it is not the one shown: an ask opened from the glance.
  var from: String? = nil
  let answer: (_ approved: Bool, _ remember: Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        KOSFace(size: 44, mood: .needsYou)
        VStack(alignment: .leading, spacing: 2) {
          Text((from ?? ask.asker).map { "\($0) asks" } ?? "KOS asks").font(.kos(.detail, .semibold)).foregroundStyle(Theme.warn).lineLimit(1)
          Text(ask.tool).font(.kos(.detail, design: .monospaced)).foregroundStyle(Theme.faint).lineLimit(1)
        }
        Spacer(minLength: 0)
        if more > 0 { Pill("\(more) more", tone: .warn) }
      }
      .accessibilityElement(children: .combine)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          AskSummary(ask)
          if let args = ask.args { AskDetails(tool: ask.tool, args: args) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.hidden)

      if let expires = ask.expires { Lapse(until: expires) }
      if ask.always == nil, let note = ask.alwaysNote { Text(note).font(.kos(.detail)).foregroundStyle(Theme.faint) }
      VStack(spacing: 8) {
        Button("Approve") { answer(true, false) }
          .buttonStyle(KOSButtonStyle(.primary, large: true))
          .accessibilityHint("KOS runs \(ask.tool) once")
        if let always = ask.always {
          Button(always) { answer(true, true) }
            .buttonStyle(KOSButtonStyle(.secondary, large: true))
            .accessibilityHint(ask.alwaysTip ?? "Approves, and stops asking for this")
        }
        Button("Deny") { answer(false, false) }
          .buttonStyle(KOSButtonStyle(.secondary, large: true))
          .accessibilityHint("KOS will not run \(ask.tool)")
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 24)
    .padding(.bottom, 12)
  }
}

/// How long the ask has before it answers itself, ticking, and a bar the width of the sheet running down.
private struct Lapse: View {
  let until: Date
  @State private var from = Date()

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let total = max(1, until.timeIntervalSince(from))
      let left = max(0, until.timeIntervalSince(context.date))
      VStack(alignment: .leading, spacing: 6) {
        Text("Lapses in \(secondsLeft(until: until, now: context.date))")
          .font(.kos(.detail).monospacedDigit())
          .foregroundStyle(left <= 15 ? Theme.warn : Theme.faint)
        GeometryReader { box in
          Capsule().fill(Theme.line)
            .overlay(alignment: .leading) {
              Capsule().fill(left <= 15 ? Theme.warn : Theme.faint).frame(width: box.size.width * left / total)
            }
        }
        .frame(height: 3)
      }
    }
    .accessibilityElement(children: .combine)
  }
}
