import DeviceCore
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
  /// When it was said, drawn on its left while `timeShown`; with none, no room is kept for it.
  let time: Date?
  let timeShown: Bool

  public init(text: String, files: [String], quote: ChatModel.Quote? = nil, time: Date? = nil, timeShown: Bool = false) {
    self.text = text
    self.files = files
    self.quote = quote
    self.time = time
    self.timeShown = timeShown
  }

  /// A file named as a picture is, by its extension.
  static func isPicture(_ name: String) -> Bool {
    ["jpg", "jpeg", "png", "gif", "webp", "heic"].contains((name as NSString).pathExtension.lowercased())
  }

  public var body: some View {
    HStack {
      // Up to 88% of the thread's width, as on the dashboard.
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 6) {
        if let quote { QuoteCard(text: quote.text, from: quote.from) }
        if !text.isEmpty { ChatMarkdown(text) }
        ForEach(files, id: \.self) { file in
          Label(file, systemImage: Self.isPicture(file) ? "photo" : "doc").font(.kos(.detail)).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .background(
        UnevenRoundedRectangle(topLeadingRadius: Theme.radiusLg, bottomLeadingRadius: Theme.radiusLg, bottomTrailingRadius: Theme.radiusXs, topTrailingRadius: Theme.radiusLg, style: .continuous)
          .fill(Self.fill))
      // Its time left of it, in the room the spacer keeps: drawn over the row, so the bubble is as wide without one.
      .overlay(alignment: .bottomLeading) {
        if let time {
          MessageTime(time, shown: timeShown).frame(width: 0, alignment: .trailing).offset(x: -8, y: -10)
        }
      }
    }
  }
}

/// A turn's tool calls, folded to one chip that opens to them; live, the step it is on, in the accent.
/// Under it, what the steps saw, as the dashboard and the side panel show it.
public struct Steps: View {
  let steps: [ChatModel.Step]
  let live: Bool
  let pictures: [ChatModel.Picture]
  @State private var open = false
  @Environment(\.accessibilityReduceMotion) private var still

  public init(steps: [ChatModel.Step], live: Bool = false, pictures: [ChatModel.Picture] = []) {
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
  let pictures: [ChatModel.Picture]
  @State private var open: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: StepPicture.small, maximum: StepPicture.small), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
        ForEach(pictures, id: \.id) { picture in
          StepPicture(picture) { withAnimation(Theme.spring) { open = open == picture.id ? nil : picture.id } }
        }
      }
      if let open, let picture = pictures.first(where: { $0.id == open }) {
        StepPicture(picture, open: true) { withAnimation(Theme.spring) { self.open = nil } }
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

/// A message's own time, as the dashboard's `.msg-time`: small and faint, kept in its place while hidden so nothing
/// moves when it shows; its help says the date in full.
public struct MessageTime: View {
  let date: Date
  let shown: Bool

  public init(_ date: Date, shown: Bool) {
    self.date = date
    self.shown = shown
  }

  public var body: some View {
    let card = ChatTime.card(date)
    Text(ChatTimes.clock(date))
      .font(.kos(.tiny).monospacedDigit())
      .foregroundStyle(Theme.faint)
      .fixedSize()
      .opacity(shown ? 1 : 0)
      .animation(Theme.hover, value: shown)
      .help("\(card.date)\n\(card.time)")
      .accessibilityLabel("\(card.date) \(card.time)")
      .accessibilityHidden(!shown)
  }
}

/// The quiet line over a message where the day changes ("Today") or after a pause ("9:41 AM"), as the dashboard's `.chat-mark`.
public struct TimeMarkLine: View {
  let mark: ChatTimes.Mark

  public init(_ mark: ChatTimes.Mark) {
    self.mark = mark
  }

  public var body: some View {
    // Drawn again at each midnight, so "Today" becomes "Yesterday" on a window left open.
    TimelineView(.explicit(Self.midnights())) { context in
      Text(ChatTimes.words(mark, now: context.date))
        .font(.kos(.tiny).monospacedDigit())
        .foregroundStyle(Theme.faint)
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .accessibilityAddTraits(.isHeader)
    }
  }

  /// The next week's midnights on the owner's clock.
  static func midnights(from now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> [Date] {
    let today = calendar.startOfDay(for: now)
    return [now] + (1...7).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
  }
}

private struct ChatTimesShownKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// Every line in the thread shows its time: the phone's swipe to the left, as iMessage reveals its times.
  public var chatTimesShown: Bool {
    get { self[ChatTimesShownKey.self] }
    set { self[ChatTimesShownKey.self] = newValue }
  }
}

extension View {
  /// Shows a message's time while the pointer is over it on a Mac, and from a tap until the next where nothing hovers.
  public func timeReveal(_ shown: Binding<Bool>) -> some View {
    #if os(macOS)
      onHover { shown.wrappedValue = $0 }
    #else
      contentShape(Rectangle()).onTapGesture { shown.wrappedValue.toggle() }
    #endif
  }
}

/// One line of the chat as both devices draw it: the owner's bubble, KOS's words, a note, or a turn's steps. A line
/// with a time shows it on hover on a Mac, or from a tap on the phone: the owner's left of their bubble, KOS's under
/// its words, a note's after it, each keeping its room while hidden.
public struct ChatLine: View {
  let line: ChatModel.Line
  let time: Date?
  let pictures: [ChatModel.Picture]
  @State private var hovered = false
  /// Every line's time at once, while the thread asks: the phone's swipe to the left.
  @Environment(\.chatTimesShown) private var allShown

  private var timeShown: Bool { hovered || allShown }

  public init(_ line: ChatModel.Line, time: Date?, pictures: [ChatModel.Picture]) {
    self.line = line
    self.time = time
    self.pictures = pictures
  }

  public var body: some View {
    content
      #if !os(macOS)
        // A tap shows it for a moment; a pointer over it on a Mac shows it for as long as it stays.
        .task(id: hovered) {
          guard hovered else { return }
          try? await Task.sleep(for: Self.tapped)
          if !Task.isCancelled { hovered = false }
        }
      #endif
  }

  @ViewBuilder private var content: some View {
    switch line {
    case .you(let text, let files, let quote):
      Bubble(text: text, files: files, quote: quote, time: time, timeShown: timeShown).timeReveal($hovered)
    case .kos(let text):
      VStack(alignment: .leading, spacing: 3) {
        ChatMarkdown(text)
        if let time { MessageTime(time, shown: timeShown) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .timeReveal($hovered)
    case .note(let text):
      // Its time after it, and the same room kept before it, so the note stays centred.
      HStack(alignment: .lastTextBaseline, spacing: 8) {
        if let time { MessageTime(time, shown: false).hidden().accessibilityHidden(true) }
        Text(text).font(.kos(.tiny)).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
        if let time { MessageTime(time, shown: timeShown) }
      }
      .frame(maxWidth: .infinity)
      .timeReveal($hovered)
    case .steps(let steps):
      Steps(steps: steps, pictures: pictures)
    }
  }
}

extension ChatLine {
  /// How long a time a tap showed stays before it hides again, as the dashboard's.
  static let tapped: Duration = .seconds(4)
}
