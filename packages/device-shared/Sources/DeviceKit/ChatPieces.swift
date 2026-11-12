import SwiftUI

/// The pieces a device's chat is drawn from, the Mac's window and the phone
/// alike (docs/components.md, The chat): the owner's bubble, a turn's steps
/// folded to a chip with what they saw, and the foot of a running turn.

/// The owner's words: on the right, the accent's tint over panel-2, the corner by the edge tucked in.
/// In light, the dashboard's lighter tint over the white panel, which panel-2's grey made dull.
public struct Bubble: View {
  private static let fill = Color(
    dark: Theme.Dark.accent.opacity(0.18).blended(over: Theme.Dark.panel2),
    light: Theme.Light.accent.opacity(0.09).blended(over: Theme.Light.panel))
  let text: String
  let files: [String]
  let quote: ChatModel.Quote?

  public init(text: String, files: [String], quote: ChatModel.Quote? = nil) {
    self.text = text
    self.files = files
    self.quote = quote
  }

  public var body: some View {
    HStack {
      // Up to 88% of the thread's width, as on the dashboard.
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 6) {
        if let quote { QuoteCard(text: quote.text, from: quote.from) }
        if !text.isEmpty { ChatMarkdown(text) }
        ForEach(files, id: \.self) { file in
          Label(file, systemImage: "doc").font(.kos(.detail)).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .background(
        UnevenRoundedRectangle(topLeadingRadius: Theme.radiusLg, bottomLeadingRadius: Theme.radiusLg, bottomTrailingRadius: Theme.radiusXs, topTrailingRadius: Theme.radiusLg, style: .continuous)
          .fill(Self.fill))
    }
  }
}

/// A turn's tool calls, folded to one chip that opens to them; live, the step it is on, in the accent.
/// Under it, what the steps saw, as the dashboard and the side panel show it.
public struct Steps: View {
  let steps: [ChatModel.Step]
  let live: Bool
  let pictures: [(id: Int, data: Data)]
  @State private var open = false
  @Environment(\.accessibilityReduceMotion) private var still

  public init(steps: [ChatModel.Step], live: Bool = false, pictures: [(id: Int, data: Data)] = []) {
    self.steps = steps
    self.live = live
    self.pictures = pictures
  }

  private var label: String {
    let failed = steps.filter(\.failed).count
    let said = live
      ? "\(steps.count > 1 ? "\(steps.count). " : "")\(steps.last?.summary ?? "Working")"
      : "\(steps.count) step\(steps.count == 1 ? "" : "s")"
    return failed > 0 ? "\(said) · \(failed) failed" : said
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        guard !live else { return }
        withAnimation(still ? nil : Theme.spring) { open.toggle() }
      } label: {
        Chip(label, symbol: "checklist", lit: live, pressable: !live, opens: live ? nil : open)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(live ? "Working: \(steps.last?.summary ?? "a step")" : "\(label). \(open ? "Hide" : "Show") the steps")
      if open && !live {
        VStack(alignment: .leading, spacing: 3) {
          ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(verbatim: "\(i + 1).").monospacedDigit().frame(minWidth: 14, alignment: .trailing)
              Text(step.summary)
            }
            .font(.kos(.dense))
            .foregroundStyle(step.failed ? Theme.danger : Theme.muted)
          }
        }
        .padding(.leading, 6)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
      if !pictures.isEmpty {
        FlowPictures(pictures: pictures)
      }
    }
  }
}

/// The steps' pictures in rows that wrap, the newest last; the one pressed opens full width under them.
private struct FlowPictures: View {
  let pictures: [(id: Int, data: Data)]
  @State private var open: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: StepPicture.small, maximum: StepPicture.small), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
        ForEach(pictures, id: \.id) { picture in
          StepPicture(picture.data) { withAnimation(Theme.spring) { open = open == picture.id ? nil : picture.id } }
        }
      }
      if let open, let picture = pictures.first(where: { $0.id == open }) {
        StepPicture(picture.data, open: true) { withAnimation(Theme.spring) { self.open = nil } }
          .transition(.opacity)
      }
    }
  }
}

/// The dashboard's live head, at the foot of a running turn: three dots of the accent pulsing in turn, what it is at, and for how long.
/// Not live, held on the owner, it is the words alone: no dots, no clock counting the owner's time.
public struct Working: View {
  let what: String
  let since: Date
  let live: Bool

  public init(what: String, since: Date, live: Bool) {
    self.what = what
    self.since = since
    self.live = live
  }

  public var body: some View {
    HStack(spacing: 8) {
      if live { dots }
      Text(what).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
      if live { elapsed }
    }
    .padding(.vertical, 4)
  }

  private var dots: some View {
    TimelineView(.animation) { context in
      let now = context.date.timeIntervalSinceReferenceDate
      HStack(spacing: 3) {
        ForEach(0..<3, id: \.self) { i in
          Dot(Theme.accent, size: 4).opacity(Self.pulse(at: now - Double(i) * 0.15))
        }
      }
    }
  }

  private var elapsed: some View {
    TimelineView(.periodic(from: since, by: 1)) { context in
      Text(elapsedWords(context.date.timeIntervalSince(since)))
        .font(.kos(.detail).monospacedDigit())
        .foregroundStyle(Theme.faint)
    }
  }

  /// The dashboard's live-pulse: a quarter lit, up to full at 30% of each 1.1 s, and back by 60%.
  static func pulse(at time: Double) -> Double {
    let period = 1.1
    let at = (time.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period) / period
    let rise = at < 0.3 ? at / 0.3 : at < 0.6 ? 1 - (at - 0.3) / 0.3 : 0
    return 0.25 + 0.75 * rise
  }
}
