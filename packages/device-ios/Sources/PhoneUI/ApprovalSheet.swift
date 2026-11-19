import DeviceCore
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
        AskBody(ask: ask, more: chat.asks.count - 1) { approved, remember, code in
          chat.answer(ask.id, approved: approved, remember: remember, code: code)
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
/// long it has and the buttons for the thumb, full width, Approve first. An ask for a one-time code has its masked
/// box above the buttons (`AskCodeField`), and Approve only once a code is in it.
struct AskBody: View {
  let ask: ChatModel.Ask
  /// How many more wait after this one.
  let more: Int
  /// The chat it is for, when it is not the one shown: an ask opened from the glance.
  var from: String? = nil
  /// `code` is the one-time code typed on the card, for an ask for one.
  let answer: (_ approved: Bool, _ remember: Bool, _ code: String?) -> Void
  /// What is typed in the code's box, for this sheet alone: sent with the yes, then emptied.
  @State private var code = ""

  private var asksCode: Bool { ask.secret?.asksCode == true }
  private var typed: String? { OneTimeCode.typed(code) }

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

      if let secret = ask.secret, secret.asksCode { AskCodeField(secret: secret, code: $code) { approve() } }
      if let expires = ask.expires { Lapse(until: expires) }
      if ask.tooLong {
        Text("Too long to show here in full. Open it in the dashboard's Inbox to approve it.").font(.kos(.detail)).foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      } else if ask.always == nil, let note = ask.alwaysNote {
        Text(note).font(.kos(.detail)).foregroundStyle(Theme.faint)
      }
      VStack(spacing: 8) {
        if !ask.tooLong {
          Button("Approve") { approve() }
            .buttonStyle(KOSButtonStyle(.primary, large: true))
            .disabled(asksCode && typed == nil)
            .accessibilityHint("KOS runs \(ask.tool) once")
        }
        if let always = ask.always, !ask.tooLong, !asksCode {
          Button(always) { answer(true, true, nil) }
            .buttonStyle(KOSButtonStyle(.secondary, large: true))
            .accessibilityHint(ask.alwaysTip ?? "Approves, and stops asking for this")
        }
        Button("Deny") {
          code = ""
          answer(false, false, nil)
        }
          .buttonStyle(KOSButtonStyle(.secondary, large: true))
          .accessibilityHint("KOS will not run \(ask.tool)")
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 24)
    .padding(.bottom, 12)
  }

  /// A yes, with the code for an ask for one; the box emptied as it goes.
  private func approve() {
    let sent = asksCode ? typed : nil
    guard !asksCode || sent != nil else { return }
    code = ""
    answer(true, false, sent)
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
