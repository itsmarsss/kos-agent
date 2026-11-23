import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The box, voice first: the microphone is the big button, and the field
/// beside it takes typing and the keyboard's own dictation. With words in
/// the field the button sends them; listening, the field shows what is
/// heard, the button sends it and the cross drops it. On the left, attach:
/// a photo or a file to go with the words, shown over the box until it goes.
///
/// Three controls, one height: attach took speak replies' place rather than
/// a fourth button, which at 390 points left the field too narrow to read
/// what was typed. Speak replies is in the settings sheet, where it was too.
/// The chat's mode is a line of its own over them for the same reason: its
/// chip cycles Ask and Auto, and its chevron opens the mode's sheet.
struct Composer: View {
  @ObservedObject var chat: ChatModel
  @ObservedObject var voice: VoiceModel
  @ObservedObject var tray: AttachmentTray
  @FocusState private var typing: Bool
  @State private var picking: Picking.Source?
  @State private var modeSheet: Bool

  init(chat: ChatModel, voice: VoiceModel, tray: AttachmentTray, modeSheet: Bool = false) {
    self.chat = chat
    self.voice = voice
    self.tray = tray
    _modeSheet = State(initialValue: modeSheet)
  }
  @Environment(\.accessibilityReduceMotion) private var still

  /// The row's one height, every control in it: a thumb's, and then some.
  static let button: CGFloat = 56

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let error = chat.error {
        Text(error).font(.kos(.detail)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
      } else if let note = tray.note {
        Text(note).font(.kos(.detail)).foregroundStyle(Theme.warn).fixedSize(horizontal: false, vertical: true)
      } else if let note = voice.note {
        Text(note).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      } else if case .unavailable(let why) = voice.state {
        Text(why).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      if !tray.files.isEmpty {
        AttachmentStrip(files: tray.files, remove: tray.remove)
      }
      ModeChip(mode: chat.mode, open: modeSheet, keys: false, height: Self.modeHeight, cycle: { chat.cycleMode() }, menu: { modeSheet = true })
      HStack(alignment: .bottom, spacing: 10) {
        side
        field
        main
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .background(Theme.bg)
    .overlay(alignment: .top) { Hairline() }
    .opacity(chat.usable ? 1 : 0.55)
    .disabled(!chat.usable)
    .animation(still ? nil : Theme.spring, value: voice.state)
    .animation(still ? nil : Theme.spring, value: tray.files)
    .modifier(Picking(source: $picking, tray: tray))
    .sheet(isPresented: $modeSheet) { ModeSheet(chat: chat) }
  }

  /// The mode's line: a chip a thumb can press, under the row's own height.
  static let modeHeight: CGFloat = 34

  /// Attach, or, listening, the cross that drops what was heard.
  @ViewBuilder
  private var side: some View {
    if voice.listening || voice.state == .asking {
      RoundButton(symbol: "xmark", label: "Cancel", kind: .secondary, size: Self.button) { voice.cancel() }
    } else {
      Menu {
        Button { picking = .photos } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
        Button { picking = .files } label: { Label("Choose File", systemImage: "folder") }
      } label: {
        RoundFace(symbol: "plus", kind: .secondary, size: Self.button)
      }
      .menuStyle(.button)
      .buttonStyle(.plain)
      .menuIndicator(.hidden)
      .fixedSize()
      .disabled(tray.full)
      .accessibilityLabel("Attach")
      .accessibilityHint("A photo or a file to send with your words")
    }
  }

  @ViewBuilder
  private var field: some View {
    let shape = RoundedRectangle(cornerRadius: Self.button / 2, style: .circular)
    Group {
      if voice.listening || voice.state == .asking {
        HStack(spacing: 10) {
          Listening(on: voice.state == .listening)
          Text(voice.words.isEmpty ? (voice.state == .asking ? "Asking to listen…" : "Listening…") : voice.words)
            .font(.kos(.body))
            .foregroundStyle(voice.words.isEmpty ? Theme.muted : Theme.text)
            .lineLimit(4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(voice.words.isEmpty ? "Listening" : "Heard: \(voice.words)")
      } else {
        TextField("", text: $chat.draft, axis: .vertical)
          .textFieldStyle(.plain)
          .font(.kos(.body))
          .lineLimit(1...5)
          .focused($typing)
          .submitLabel(.send)
          .onSubmit(sendDraft)
          .overlay(alignment: .leading) {
            if chat.draft.isEmpty {
              Text("Message KOS").font(.kos(.body)).foregroundStyle(Theme.faint).allowsHitTesting(false)
            }
          }
          .accessibilityLabel("Message KOS")
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 10)
    .frame(minHeight: Self.button)
    .background(Theme.panel, in: shape)
    .overlay(shape.strokeBorder(typing ? Theme.accent.opacity(0.6) : Theme.line))
  }

  /// The microphone; send, with words typed; send what was heard, listening.
  @ViewBuilder
  private var main: some View {
    let hasDraft = !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !tray.files.isEmpty
    if hasDraft && !voice.listening {
      RoundButton(symbol: "arrow.up", label: "Send", kind: .primary, size: Self.button, action: sendDraft)
    } else {
      RoundButton(
        symbol: voice.listening ? "arrow.up" : "mic.fill", label: voice.listening ? "Send what I said" : "Talk to KOS", kind: .primary, size: Self.button
      ) {
        typing = false
        voice.press()
      }
      .accessibilityHint(voice.listening ? "Sends what was heard" : "Listens, and sends when you pause")
    }
  }

  private func sendDraft() {
    let words = chat.draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty || !tray.files.isEmpty, chat.usable else { return }
    chat.draft = ""
    chat.say(words, files: tray.files.map(\.name))
  }
}

/// A round button of one symbol, 44 points or the size given: the accent's for the one thing to do,
/// a quiet one beside it, or lit when what it turns on is on.
struct RoundButton: View {
  enum Kind { case primary, secondary, lit }

  let symbol: String
  let label: String
  var kind: Kind = .secondary
  var size: CGFloat = 44
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      RoundFace(symbol: symbol, kind: kind, size: size)
    }
    .buttonStyle(Pressed())
    .accessibilityLabel(label)
  }

  /// A touch smaller pressed, as every control is.
  private struct Pressed: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
      configuration.label
        .scaleEffect(configuration.isPressed ? 0.94 : 1)
        .animation(Theme.press, value: configuration.isPressed)
    }
  }
}

/// What a round button looks like, for a button and for a menu's label alike, so both share one size and one edge.
struct RoundFace: View {
  let symbol: String
  var kind: RoundButton.Kind = .secondary
  var size: CGFloat = 44
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.4, weight: .semibold))
      .contentTransition(.symbolEffect(.replace))
      .foregroundStyle(kind == .primary ? Theme.onAccent : kind == .lit ? Theme.accent : enabled ? Theme.muted : Theme.faint)
      .frame(width: size, height: size)
      .background(fill, in: Circle())
      .overlay(Circle().strokeBorder(kind == .secondary ? Theme.line : kind == .lit ? Theme.accent.opacity(Theme.edge) : .clear))
      .contentShape(Circle())
  }

  private var fill: Color {
    switch kind {
    case .primary: Theme.accent
    case .secondary: Theme.panel
    case .lit: Theme.accent.opacity(Theme.tint)
    }
  }
}

/// Listening: three bars of the accent that rise and fall, still under Reduce Motion.
private struct Listening: View {
  let on: Bool
  @Environment(\.accessibilityReduceMotion) private var still

  var body: some View {
    TimelineView(.animation(paused: still || !on)) { context in
      let t = context.date.timeIntervalSinceReferenceDate
      HStack(spacing: 3) {
        ForEach(0..<3, id: \.self) { i in
          Capsule()
            .fill(Theme.accent)
            .frame(width: 4, height: Self.height(at: t, bar: i, live: on && !still))
        }
      }
      .frame(width: 20, height: 22)
    }
    .accessibilityHidden(true)
  }

  static func height(at t: Double, bar: Int, live: Bool) -> CGFloat {
    guard live else { return [10, 16, 10][bar] }
    return 6 + 14 * abs(sin(t * 5 + Double(bar) * 1.1))
  }
}

/// The mode chip's sheet: the shared menu under a head, as tall as it needs, as RowSheet stops at its content.
struct ModeSheet: View {
  @ObservedObject var chat: ChatModel
  @Environment(\.dismiss) private var dismiss
  @State private var fit: CGFloat = 0

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("This chat's mode").font(.kos(.title, .semibold)).foregroundStyle(Theme.text)
          Spacer()
          Button("Done") { dismiss() }.buttonStyle(.plain).font(.kos(.body, .semibold)).foregroundStyle(Theme.accent)
        }
        .padding(.top, 20)
        .padding(.bottom, 12)
        ModeMenu(mode: chat.mode) { mode in
          // A mode or a span picked is done with; the sessions switch is not.
          let onlySessions = mode.mode == chat.mode.mode && mode.until == chat.mode.until
          chat.choose(mode)
          if !onlySessions { dismiss() }
        }
        .padding(.bottom, 20)
      }
      .padding(.horizontal, Theme.gutter)
      .background(GeometryReader { box in Color.clear.preference(key: FitHeight.self, value: box.size.height) })
    }
    .scrollBounceBehavior(.basedOnSize)
    .background(Theme.bg)
    .onPreferenceChange(FitHeight.self) { fit = $0 }
    .presentationDetents(fit > 0 ? [.height(fit), .large] : [.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
