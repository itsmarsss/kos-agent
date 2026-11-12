import DeviceCore
import DeviceKit
import DeviceLink
import Foundation

/// KOS for iPhone as one thing: the pairing it keeps, the line to that KOS,
/// and the chat, glance and voice the screens draw.
///
/// It talks to one KOS. Its calls are the chat calls KOS for Mac's window
/// takes, drawn the same way (ChatCalls), the glance and the artifacts; any
/// other call is refused, since a phone has no screen for KOS to see or work.
/// Its words go as the `phone` surface's, beside nothing, with the files
/// picked for them.
@MainActor
public final class Phone: ObservableObject {
  /// What this app is to KOS (docs/computer.md, A phone).
  public static let platform = "ios"

  public let chat = ChatModel()
  public let glance = GlanceModel()
  public let artifacts: ArtifactShelf
  public let tray = AttachmentTray()
  public let voice: VoiceModel
  public let reader: ReplyReader
  public let pairing: PairingFlow

  /// The KOS this phone is paired with, none before it is.
  @Published public private(set) var paired: Pairing?
  /// The dashboard's theme as that KOS last sent it, kept from the last launch until it sends again.
  @Published public private(set) var theme: DashboardTheme?
  /// Said over the pairing screen when the saved pairing could not be read or kept.
  @Published public private(set) var problem: String?

  /// How long the phone waits on KOS: to say it has the owner's words, and to show the chat once asked.
  public struct Timing: Sendable {
    public var takeWithin: Duration
    public var showWithin: Duration
    public var sleep: @Sendable (Duration) async -> Void

    public init(takeWithin: Duration, showWithin: Duration, sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
      self.takeWithin = takeWithin
      self.showWithin = showWithin
      self.sleep = sleep
    }

    /// The side panel's waits: twelve seconds for the words, six for the chat.
    public static let standard = Timing(takeWithin: .seconds(12), showWithin: .seconds(6))
  }

  private let vault: PairingVault
  private let makeLine: () -> Line
  private let haptics: Haptics
  private let preferences: Preferences
  private let timing: Timing
  private var line: Line?
  private var wasOnline = false
  private var taking: Task<Void, Never>?
  private var showing: Task<Void, Never>?
  /// The turn that was working, so its end asks for a fresh glance.
  private var wasWorking = false
  private var watch: Task<Void, Never>?
  /// Asked to listen (Ask KOS) before KOS was on the line to hear: it listens once the chat is shown.
  private var listenWhenShown = false

  public init(
    vault: PairingVault, pairer: Pairer, recognizer: SpeechRecognizer, speaker: Speaker, haptics: Haptics, preferences: Preferences,
    line: @escaping () -> Line, name: String = "iPhone", timing: Timing = .standard
  ) {
    self.vault = vault
    makeLine = line
    self.haptics = haptics
    self.preferences = preferences
    self.timing = timing
    voice = VoiceModel(recognizer: recognizer)
    artifacts = ArtifactShelf(sleep: timing.sleep)
    reader = ReplyReader(speaker: speaker, preferences: preferences)
    pairing = PairingFlow(pairer: pairer, name: name)
    theme = preferences.value(KeptTheme.self, Keys.theme)?.theme
    if let face = preferences.value(FaceDrawing.self, Keys.face) { chat.face = FaceLook(face) }
    wire()
  }

  /// How the app is drawn: as the dashboard looks, the phone's own appearance before KOS has said.
  public var mode: ThemeMode { ThemeChoice.dashboard.mode(sent: theme) }

  // MARK: Life

  /// The saved pairing, read, and its line dialled.
  public func start() {
    do {
      paired = try vault.load().first
    } catch {
      problem = (error as? DeviceError)?.message ?? error.localizedDescription
    }
    chat.paired = paired != nil
    if let paired { dial(paired) }
  }

  /// Back on screen: a line the system let drop is dialled again, and the chat and glance are asked for afresh.
  public func foreground() {
    guard paired != nil else { return }
    if chat.online {
      opened()
    } else {
      line?.redialNow()
    }
  }

  /// Off screen: nothing is read aloud to a phone in a pocket. The line is left to the system.
  public func background() {
    reader.stop()
    voice.cancel()
  }

  /// Ask KOS, from outside the app's screens: listening starts now, or once KOS has shown the chat. Not paired, the
  /// pairing screen is what shows, and nothing listens.
  public func listen() {
    guard paired != nil else { return }
    if chat.usable {
      beginListening()
    } else {
      listenWhenShown = true
    }
  }

  private func beginListening() {
    listenWhenShown = false
    guard !voice.listening, voice.state != .asking else { return }
    reader.stop()
    voice.press()
  }

  /// Forgets this KOS here and tells it to forget this phone, then shows the pairing again.
  public func unpair() {
    let keptLine = line
    line = nil
    forget()
    keptLine?.unpair {}
  }

  // MARK: The line

  private func dial(_ pairing: Pairing) {
    line?.stop()
    let line = makeLine()
    line.state = { .phone }
    line.onStatus = { [weak self] status in self?.status(status) }
    line.onCall = { [weak self] call in self?.handle(call) }
    line.onRemoved = { [weak self] in self?.removed() }
    line.onFace = { [weak self] face in self?.faced(face) }
    line.onTheme = { [weak self] theme in self?.themed(theme) }
    self.line = line
    chat.link = .connecting
    line.start(pairing)
  }

  private func status(_ status: Connection.Status) {
    chat.link = LinkState(status)
    let online = chat.online
    defer { wasOnline = online }
    if online && !wasOnline { opened() }
    // Words on their way when the line dropped were never taken: they go back to the owner.
    if !online && wasOnline && !chat.sending.isEmpty {
      chat.giveBack("The line to KOS dropped. Your words are back in the box.")
      tray.giveBack()
    }
  }

  /// Shown the chat, the chats and the glance, and told when KOS does not show it.
  private func opened() {
    tell(.open)
    tell(.list)
    glance.ask()
    showing?.cancel()
    let sleep = timing.sleep, within = timing.showWithin
    showing = Task { [weak self] in
      await sleep(within)
      guard !Task.isCancelled, let self, self.chat.online else { return }
      // On and silent: a KOS from before phones, that cannot talk here.
      self.chat.silent = true
    }
  }

  /// A call from KOS: the chat's, drawn; the glance, kept; anything else refused, as a phone has nothing else.
  func handle(_ call: Call) -> Data? {
    do {
      if call.method == Glance.method {
        glance.received(try call.params(Glance.self))
        return try? Outbound.reply(id: call.id, result: EmptyResult())
      }
      if let artifact = try artifactCall(call) { return artifact }
      guard let method = ChatMethod(rawValue: call.method) else {
        return try? Outbound.reply(id: call.id, error: .badRequest("KOS for iPhone only chats: it has no \(call.method)."))
      }
      let asks = chat.asks.count
      switch try ChatCalls.draw(call, as: method, into: chat) {
      case .shown:
        showing?.cancel()
        showing = nil
        // Words the chat does not have yet are still KOS's to take: the wait on them goes on.
        if chat.sending.isEmpty {
          heardBack()
          tray.kept()
        }
        reader.shown(conversation: chat.conversation, lines: chat.lines)
        if listenWhenShown && chat.usable { beginListening() }
      case .status:
        heardBack()
        // Refused with the words (a file that did not arrive whole), they are back in the box, and so are the files.
        if chat.error != nil { tray.giveBack() } else if (try? call.params(ChatStatus.self))?.taken == true { tray.kept() }
      case .other:
        if chat.asks.count > asks { haptics.attention() }
        // Decided elsewhere: the glance's row goes as the chat's card does.
        if method == .settled, let settled = try? call.params(ChatSettled.self) { glance.settled(settled.approval) }
      }
      return try? Outbound.reply(id: call.id, result: EmptyResult())
    } catch let error as DeviceError {
      return try? Outbound.reply(id: call.id, error: error)
    } catch {
      return try? Outbound.reply(id: call.id, error: DeviceError(.internal, error.localizedDescription))
    }
  }

  /// A call about the owner's artifacts, answered; nil for any other.
  private func artifactCall(_ call: Call) throws -> Data? {
    switch call.method {
    case ArtifactItem.listMethod: artifacts.received(try call.params(ArtifactList.self))
    case ArtifactOpened.method: artifacts.received(try call.params(ArtifactOpened.self))
    case ArtifactReadAnswer.method: artifacts.received(try call.params(ArtifactReadAnswer.self))
    default: return nil
    }
    return try Outbound.reply(id: call.id, result: EmptyResult())
  }

  private func faced(_ face: FaceDrawing) {
    chat.face = FaceLook(face)
    preferences.setValue(face, Keys.face)
  }

  private func themed(_ theme: DashboardTheme) {
    guard theme != self.theme else { return }
    self.theme = theme
    preferences.setValue(KeptTheme(theme), Keys.theme)
  }

  /// KOS no longer knows this phone: it is unpaired here too, and says so.
  private func removed() {
    line = nil
    forget()
    pairing.note("KOS no longer knows this iPhone. Pair it again.")
  }

  private func forget() {
    line?.stop()
    do {
      try vault.save([])
    } catch {
      problem = (error as? DeviceError)?.message ?? error.localizedDescription
    }
    paired = nil
    chat.paired = false
    leave()
  }

  /// Nothing of the KOS this phone was with stays: its theme, its face, its chat and its glance.
  private func leave() {
    theme = nil
    preferences.set(nil, forKey: Keys.theme)
    preferences.set(nil, forKey: Keys.face)
    reader.stop()
    voice.cancel()
    chat.reset()
    chat.link = nil
    chat.face = .kos
    glance.reset()
    artifacts.reset()
    tray.reset()
    listenWhenShown = false
    wasOnline = false
  }

  // MARK: The owner

  private func wire() {
    pairing.paired = { [weak self] pairing in self?.keep(pairing) }
    pairing.current = { [weak self] in self?.paired?.address }
    chat.send = { [weak self] text, _ in self?.say(text) }
    // Decided in the chat or in the glance, by its id either way; the other drops it too.
    chat.decide = { [weak self] id, approved, remember in
      self?.glance.settled(id)
      self?.decided(id, approved: approved, remember: remember)
    }
    glance.decide = { [weak self] id, approved, remember in
      self?.chat.settled(id)
      self?.decided(id, approved: approved, remember: remember)
    }
    chat.list = { [weak self] in self?.tell(.list) }
    chat.switchTo = { [weak self] id in self?.tell(.switchTo(conversation: id)) }
    chat.askMentions = { [weak self] q in self?.tell(.mentions(q)) }
    chat.stop = { [weak self] in
      self?.reader.stop()
      self?.tell(.stop)
    }
    glance.askKOS = { [weak self] in self?.tell(.glance) }
    artifacts.tell = { [weak self] event in self?.tell(event) }
    // Spoken words take the files picked for them, as typed ones do.
    voice.send = { [weak self] words in
      guard let self else { return }
      self.chat.say(words, files: self.tray.files.map(\.name))
    }
    // The owner's voice wins: a reply being read stops for it.
    voice.willListen = { [weak self] in self?.reader.stop() }
    // A turn ending changes what is running: the glance is asked again.
    watch = Task { [weak self] in
      guard let chat = self?.chat else { return }
      for await working in chat.$working.values {
        guard let self else { return }
        if self.wasWorking && !working && self.chat.online { self.glance.ask() }
        self.wasWorking = working
      }
    }
  }

  /// A pairing made, kept in place of any other: the KOS it replaces is told to forget this phone, and none
  /// of what it said is heard after.
  private func keep(_ pairing: Pairing) {
    do {
      try vault.save([pairing])
    } catch {
      problem = (error as? DeviceError)?.message ?? error.localizedDescription
      return
    }
    if let replaced = line {
      line = nil
      replaced.onStatus = nil
      replaced.onCall = nil
      replaced.onRemoved = nil
      replaced.onFace = nil
      replaced.onTheme = nil
      replaced.unpair {}
      leave()
    }
    problem = nil
    paired = pairing
    chat.paired = true
    haptics.done()
    dial(pairing)
  }

  private func decided(_ id: String, approved: Bool, remember: Bool) {
    haptics.tap()
    tell(.decide(approval: id, approved: approved, remember: remember))
  }

  /// The owner's words, with the files picked for them sent ahead in parts; a command goes alone, and the files wait.
  private func say(_ text: String) {
    let files = ChatMenus.isCommand(text) ? [] : tray.take()
    for file in files {
      for part in AttachmentPart.parts(id: file.id, name: file.name, mediaType: file.mediaType, bytes: file.bytes) { tell(.attach(part)) }
    }
    tell(.send(text: text, beside: .none, files: files.map(\.id)))
    // KOS says it has the words at once; nothing back in a while is a KOS that cannot talk here.
    taking?.cancel()
    let sleep = timing.sleep, within = timing.takeWithin
    taking = Task { [weak self] in
      await sleep(within)
      guard !Task.isCancelled else { return }
      self?.chat.giveBack("KOS did not take that. It may not be reachable now; your words are back in the box.")
      self?.tray.giveBack()
    }
  }

  private func heardBack() {
    taking?.cancel()
    taking = nil
  }

  private func tell(_ event: ChatEvent) {
    guard let line, let frame = try? event.frame() else { return }
    line.send(frame)
  }

  private enum Keys {
    static let theme = "dashboardTheme"
    static let face = "kosFace"
  }
}

/// The dashboard's theme as kept between launches.
private struct KeptTheme: Codable {
  let mode: ThemeMode
  let drawn: DrawnTheme?

  init(_ theme: DashboardTheme) {
    mode = theme.mode
    drawn = theme.drawn
  }

  var theme: DashboardTheme { DashboardTheme(mode: mode, drawn: drawn) }
}

extension LinkState {
  /// Where a line stands, as the screens say it.
  public init(_ status: Connection.Status) {
    switch status {
    case .connecting: self = .connecting
    case .connected: self = .connected
    case .offline(let why): self = .offline(why)
    case .untrusted: self = .untrusted
    case .replaced: self = .replaced
    case .outdated: self = .outdated
    case .disconnected: self = .disconnected
    }
  }
}
