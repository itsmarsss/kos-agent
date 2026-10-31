import AppKit
import DeviceCore
import DeviceUI

/// Wires the pieces: the pairings, a line to each KOS, the controller that answers them, and the menu.
///
/// This Mac may be paired with several KOS, each its own pairing, line and
/// rules, named everywhere by the device id that KOS gave this Mac. They
/// share one controller, so one session runs at a time whichever KOS asked.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let settings = Settings()
  private let overlay = OverlayController()
  private lazy var controller = DeviceController(settings: settings, overlay: overlay)
  private lazy var menu = StatusMenu { [unowned self] in snapshot() }
  private lazy var home = HomeWindow(settings: settings)
  /// The KOS this Mac is paired with, in the order they were paired.
  private var pairings: [Pairing] = []
  /// The line to each, by its device id.
  private var lines: [String: Connection] = [:]
  /// What each KOS was last told about this Mac.
  private var lastState: [String: DeviceState] = [:]
  private var stateTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(openURL(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))

    controller.send = { [unowned self] origin, message in lines[origin]?.send(message) }
    controller.onChange = { [unowned self] in changed() }
    controller.chatLink = { [unowned self] origin, id in try? pairing(origin)?.kosAddress().chat(id) }
    controller.kosName = { [unowned self] origin in pairings.count > 1 ? pairing(origin).map(Self.name) : nil }
    settings.onChange = { [unowned self] in
      reportStateIfChanged()
      home.refreshSystem()
      changed()
    }
    home.onPaired = { [unowned self] paired in adopt(paired) }
    let model = home.model
    model.actions.unpair = { [unowned self] id in confirmUnpair(id) }
    model.actions.reconnect = { [unowned self] id in lines[id]?.redialNow() }
    model.actions.connect = { [unowned self] id in connect(id) }
    model.actions.disconnect = { [unowned self] id in disconnect(id) }
    model.actions.setAskFirst = { [unowned self] id, on in setAskFirst(on, for: id) }
    model.actions.retryKeychain = { [unowned self] in
      loadPairings()
      changed()
    }
    model.actions.pause = { [unowned self] in controller.pause() }
    model.actions.resume = { [unowned self] in controller.resume() }
    model.actions.stop = { [unowned self] in controller.stop() }
    model.actions.setLongest = { [unowned self] in settings.longestMinutes = $0 }
    model.actions.setPromptWait = { [unowned self] in settings.promptWaitSeconds = $0 }
    model.actions.setIdle = { [unowned self] in settings.idleMinutes = $0 }
    model.actions.setConnectWhenOpened = { [unowned self] in settings.connectWhenOpened = $0 }
    model.actions.setTakeover = { [unowned self] in settings.takeover = $0 }
    model.actions.setPace = { [unowned self] in settings.pace = $0 }
    model.actions.setSounds = { [unowned self] in settings.sounds = $0 }
    model.actions.setTimeInMenuBar = { [unowned self] in settings.timeInMenuBar = $0 }
    model.actions.setOpenAtLogin = { [unowned self] on in
      if let refused = LaunchAtLogin.set(on) { alert("macOS did not change it.", refused) }
      home.refreshSystem()
    }
    model.actions.openLoginItems = { LaunchAtLogin.openLoginItems() }
    menu.onExtend = { [unowned self] in controller.extend() }
    menu.onConnect = { [unowned self] in
      for id in lines.keys where lines[id]?.status == .disconnected { connect(id) }
    }
    menu.onDisconnect = { [unowned self] in
      for id in lines.keys where lines[id]?.status != .disconnected { disconnect(id) }
    }
    menu.onReconnect = { [unowned self] in
      for line in lines.values where StatusMenu.redialable(line.status) { line.redialNow() }
    }
    menu.onOpen = { [unowned self] in home.show() }
    menu.onPause = { [unowned self] in controller.pause() }
    menu.onResume = { [unowned self] in controller.resume() }
    menu.onStop = { [unowned self] in controller.stop() }

    // Permissions change in System Settings, displays come and go: each KOS hears of it.
    stateTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.reportStateIfChanged()
        // The time left beside the icon counts down.
        if self?.controller.live != nil { self?.menu.refresh() }
      }
    }

    Log.app.notice("launched, version \(Connection.appInfo.version, privacy: .public)")
    loadPairings()
    changed()
    // Nothing to do until it is paired and granted: say so, once, at launch.
    if pairings.isEmpty || SystemPermissions.missing(SystemPermissions.current()) != nil { home.show() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    Log.app.notice("quitting")
    controller.quitting()
    lines.values.forEach { $0.stop() }
  }

  @objc private func openURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
    do {
      if let link = try PairingLink.parse(text) { home.show(prefill: link) }
    } catch let error as DeviceError {
      alert("That link did not open.", error.message)
    } catch {
      alert("That link did not open.", error.localizedDescription)
    }
  }

  // MARK: Pairings

  /// The saved pairings, each dialled at once unless the owner said to wait
  /// for Connect. A Keychain that refused them is said in the window, with Try again.
  private func loadPairings() {
    do {
      home.model.keychainProblem = nil
      let saved = try PairingStore.load()
      Log.app.notice("connect when opened: \(self.settings.connectWhenOpened, privacy: .public)")
      for paired in saved where lines[paired.deviceId] == nil {
        pairings.append(paired)
        let line = line(for: paired)
        if settings.connectWhenOpened { line.start(paired) } else { line.hold(paired) }
      }
    } catch let error as DeviceError {
      home.model.keychainProblem = error.message
    } catch {
      home.model.keychainProblem = error.localizedDescription
    }
  }

  /// A new line to one KOS, answering for that KOS alone.
  private func line(for paired: Pairing) -> Connection {
    let id = paired.deviceId
    let line = Connection()
    line.state = { [unowned self] in currentState(for: id) }
    line.onCall = { [unowned self] call in await controller.handle(call, from: id) }
    line.onDrop = { [unowned self] in controller.lineDropped(from: id) }
    line.onRemoved = { [unowned self] in forget(id, sayRemoved: true) }
    line.onStatus = { [unowned self] status in
      if case .connected = status { lastState[id] = currentState(for: id) }
      changed()
    }
    lines[id] = line
    return line
  }

  private func pairing(_ id: String) -> Pairing? {
    pairings.first { $0.deviceId == id }
  }

  /// A KOS as the owner reads it: its address.
  private static func name(_ paired: Pairing) -> String {
    (try? paired.kosAddress().display) ?? paired.address
  }

  /// Paired with a KOS: another line beside the rest, or in place of the one
  /// to the same KOS, which keeps that KOS's rule about asking first.
  private func adopt(_ paired: Pairing) {
    let replaced = Pairings.replaced(by: paired, in: pairings)
    let next = Pairings.adding(paired, to: pairings)
    do {
      try PairingStore.save(next)
    } catch let error as DeviceError {
      return alert("Paired, but not kept.", error.message)
    } catch {
      return alert("Paired, but not kept.", error.localizedDescription)
    }
    let askFirst = replaced.first.map { settings.askFirst(for: $0.deviceId) } ?? true
    for old in replaced {
      controller.lineDropped(from: old.deviceId)
      lines.removeValue(forKey: old.deviceId)?.stop()
      lastState[old.deviceId] = nil
      settings.forget(kos: old.deviceId)
    }
    pairings = next
    settings.setAskFirst(askFirst, for: paired.deviceId)
    line(for: paired).start(paired)
    Log.app.notice("paired with \(paired.kos, privacy: .public)\(replaced.isEmpty ? "" : ", in place of the old pairing", privacy: .public)")
    changed()
  }

  private func confirmUnpair(_ id: String) {
    guard let paired = pairing(id) else { return }
    let question = NSAlert()
    question.messageText = "Unpair this Mac from \(Self.name(paired))?"
    question.informativeText = "That KOS will not reach this Mac again until you pair it anew. Any other KOS stays paired."
    question.addButton(withTitle: "Unpair")
    question.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    if question.runModal() == .alertFirstButtonReturn { forget(id, sayRemoved: false) }
  }

  private func forget(_ id: String, sayRemoved: Bool) {
    let name = pairing(id).map(Self.name) ?? "KOS"
    controller.lineDropped(from: id)
    lines.removeValue(forKey: id)?.stop()
    lastState[id] = nil
    pairings = Pairings.removing(id, from: pairings)
    settings.forget(kos: id)
    do {
      try PairingStore.save(pairings)
    } catch {
      Log.pairing.error("could not keep the pairings after unpairing: \(error.localizedDescription, privacy: .public)")
    }
    Log.app.notice("unpaired from \(name, privacy: .public)\(sayRemoved ? ", which removed this Mac" : "", privacy: .public)")
    changed()
    if sayRemoved { alert("\(name) removed this Mac.", "Pair it again from Settings, Devices in that KOS to use it.") }
  }

  /// That KOS sees this Mac offline until Connect; a session it holds ends with its line.
  private func disconnect(_ id: String) {
    guard let paired = pairing(id) else { return }
    lines[id]?.hold(paired)
    changed()
  }

  private func connect(_ id: String) {
    guard let paired = pairing(id) else { return }
    lines[id]?.start(paired)
    changed()
  }

  // MARK: Settings

  private func setAskFirst(_ on: Bool, for id: String) {
    guard !on else { return settings.setAskFirst(true, for: id) }
    let question = NSAlert()
    let which = pairings.count > 1 ? pairing(id).map { " from \(Self.name($0))" } ?? "" : ""
    question.messageText = "Let KOS start sessions\(which) without asking here?"
    question.informativeText =
      "Sessions will start when you approve them in that KOS's approval queue instead, for when you are away from this Mac. The border, the bar and Stop still show for every session."
    question.addButton(withTitle: "Stop asking here")
    question.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    if question.runModal() == .alertFirstButtonReturn { settings.setAskFirst(false, for: id) }
  }

  /// The menu's icon and the window follow every line, the session and the pairings.
  private func changed() {
    menu.refresh()
    let model = home.model
    model.kos = pairings.map { paired in
      let status = lines[paired.deviceId]?.status ?? .disconnected
      var deviceName = paired.name
      if case .connected(let name) = status { deviceName = name }
      return KOSEntry(
        id: paired.deviceId, host: Self.name(paired), dashboard: try? paired.kosAddress().base, deviceName: deviceName,
        link: Self.link(status), askFirst: settings.askFirst(for: paired.deviceId))
    }
    let origin = controller.liveOrigin.flatMap(pairing)
    model.session = controller.live.map { live in
      SessionSummary(
        task: live.task, requester: live.requester, kos: pairings.count > 1 ? origin.map(Self.name) : nil,
        chat: live.conversation.flatMap { id in try? origin?.kosAddress().chat(id) }, until: live.until, paused: live.paused)
    }
  }

  private func snapshot() -> StatusMenu.Snapshot {
    StatusMenu.Snapshot(
      kos: pairings.map { (Self.name($0), lines[$0.deviceId]?.status ?? .disconnected) }, session: controller.live,
      sessionKOS: pairings.count > 1 ? controller.liveOrigin.flatMap(pairing).map(Self.name) : nil,
      timeInMenuBar: settings.timeInMenuBar)
  }

  private static func link(_ status: Connection.Status) -> LinkState {
    switch status {
    case .connecting: return .connecting
    case .connected: return .connected
    case .offline(let why): return .offline(why)
    case .untrusted: return .untrusted
    case .replaced: return .replaced
    case .outdated: return .outdated
    case .disconnected: return .disconnected
    }
  }

  // MARK: State

  private func currentState(for id: String) -> DeviceState {
    DeviceState(consent: settings.consent(for: id), permissions: SystemPermissions.current(), displays: Displays.info())
  }

  private func reportStateIfChanged() {
    for (id, line) in lines where line.isProven {
      let now = currentState(for: id)
      guard now != lastState[id], let message = try? Outbound.state(now) else { continue }
      lastState[id] = now
      line.send(message)
    }
  }

  private func alert(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
}
