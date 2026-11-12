import DeviceKit
import SwiftUI

/// What waits on the owner, decided in one tap: what KOS would run, every
/// step it takes (the ask's mechanics, never cut), why, and when it lapses;
/// Deny and Approve for the thumb, and the remembered yes when one may be.
/// The arguments fold away under Details. Several waiting, the oldest first.
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

/// One ask, as the sheet lays it out.
struct AskBody: View {
  let ask: ChatModel.Ask
  /// How many more wait after this one.
  let more: Int
  let answer: (_ approved: Bool, _ remember: Bool) -> Void
  @State private var details = false
  @Environment(\.accessibilityReduceMotion) private var still

  /// The steps, one to a line, as the ask's mechanics say them.
  private var steps: [String] {
    (ask.mechanics ?? "").split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        KOSFace(size: 44, mood: .needsYou)
        VStack(alignment: .leading, spacing: 2) {
          Text("KOS asks to run").font(.kos(.detail, .semibold)).foregroundStyle(Theme.warn)
          Text(ask.tool).font(.kos(.title, .semibold, design: .monospaced)).lineLimit(2)
        }
        Spacer(minLength: 0)
        if more > 0 { Pill("\(more) more", tone: .warn) }
      }
      .accessibilityElement(children: .combine)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if !steps.isEmpty {
            KOSSection("Steps") {
              Card(padding: EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12), spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                  HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: "\(i + 1).").monospacedDigit().foregroundStyle(Theme.faint).frame(minWidth: 16, alignment: .trailing)
                    Text(step).fixedSize(horizontal: false, vertical: true)
                  }
                  .font(.kos(.dense))
                }
              }
            }
          }
          if let why = ask.why ?? ask.reason {
            KOSSection("Why") {
              Text(why).font(.kos(.dense)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            }
          }
          if let args = ask.args {
            Button {
              withAnimation(still ? nil : Theme.spring) { details.toggle() }
            } label: {
              Chip("Details", symbol: "curlybraces", opens: details)
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .accessibilityLabel(details ? "Hide the details" : "Show the details")
            if details {
              Text(args)
                .font(.kos(.small, design: .monospaced))
                .foregroundStyle(Theme.muted)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
                .transition(.opacity)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.hidden)

      if let expires = ask.expires { Lapse(until: expires) }
      VStack(spacing: 8) {
        HStack(spacing: 10) {
          Button("Deny") { answer(false, false) }
            .buttonStyle(KOSButtonStyle(.danger, large: true))
            .accessibilityHint("KOS will not run \(ask.tool)")
          Button("Approve") { answer(true, false) }
            .buttonStyle(KOSButtonStyle(.primary, large: true))
            .accessibilityHint("KOS runs \(ask.tool) once")
        }
        if let always = ask.always {
          Button(always) { answer(true, true) }
            .buttonStyle(KOSButtonStyle(.ghost, large: true))
            .accessibilityHint("Approves, and stops asking for this")
        }
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
