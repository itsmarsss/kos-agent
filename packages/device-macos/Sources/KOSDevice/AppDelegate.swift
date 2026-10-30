import AppKit
import DeviceCore

/// Wires the pieces: the pairing, the line to KOS, the controller that answers it, and the menu.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let settings = Settings()
  private let overlay = OverlayController()
  private let connection = Connection()
  private lazy var controller = DeviceController(settings: settings, overlay: overlay)
  private lazy var menu = StatusMenu { [unowned self] in
    StatusMenu.Snapshot(paired: pairing, link: connection.status, session: controller.live, askFirst: settings.askFirst)
  }
  private let pairingWindow = PairingWindow()
  private let permissionsWindow = PermissionsWindow()
  private lazy var hiddenAppsWindow = HiddenAppsWindow(settings: settings)
  private var pairing: Pairing?
  private var lastState: DeviceState?
  private var stateTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(openURL(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))

    connection.state = { [unowned self] in currentState() }
    connection.onCall = { [unowned self] call in await controller.handle(call) }
    connection.onDrop = { [unowned self] in controller.lineDropped() }
    connection.onRemoved = { [unowned self] in forget(sayRemoved: true) }
    connection.onStatus = { [unowned self] status in
      if case .connected = status { lastState = currentState() }
      menu.refresh()
    }
    controller.send = { [unowned self] message in connection.send(message) }
    controller.onChange = { [unowned self] in menu.refresh() }
    settings.onChange = { [unowned self] in reportStateIfChanged() }
    pairingWindow.onPaired = { [unowned self] paired in adopt(paired) }
    menu.onPair = { [unowned self] in pairingWindow.show(replacing: pairing) }
    menu.onUnpair = { [unowned self] in confirmUnpair() }
    menu.onReconnect = { [unowned self] in connection.redialNow() }
    menu.onPause = { [unowned self] in controller.pause() }
    menu.onResume = { [unowned self] in controller.resume() }
    menu.onStop = { [unowned self] in controller.stop() }
    menu.onAskFirst = { [unowned self] on in setAskFirst(on) }
    menu.onHiddenApps = { [unowned self] in hiddenAppsWindow.show() }
    menu.onPermissions = { [unowned self] in permissionsWindow.show() }

    // Permissions change in System Settings, displays come and go: KOS hears of it.
    stateTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.reportStateIfChanged() }
    }

    if let saved = PairingStore.load() {
      pairing = saved
      connection.start(saved)
    } else {
      pairingWindow.show(replacing: nil)
    }
    if SystemPermissions.missing(SystemPermissions.current()) != nil { permissionsWindow.show() }
    menu.refresh()
  }

  func applicationWillTerminate(_ notification: Notification) {
    controller.quitting()
    connection.stop()
  }

  @objc private func openURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
    do {
      if let link = try PairingLink.parse(text) { pairingWindow.show(prefill: link, replacing: pairing) }
    } catch let error as DeviceError {
      alert("That link did not open.", error.message)
    } catch {
      alert("That link did not open.", error.localizedDescription)
    }
  }

  // MARK: Pairing

  private func adopt(_ paired: Pairing) {
    do {
      try PairingStore.save(paired)
    } catch let error as DeviceError {
      return alert("Paired, but not kept.", error.message)
    } catch {
      return alert("Paired, but not kept.", error.localizedDescription)
    }
    controller.stop()
    pairing = paired
    connection.start(paired)
    menu.refresh()
    if SystemPermissions.missing(SystemPermissions.current()) != nil { permissionsWindow.show() }
  }

  private func confirmUnpair() {
    let question = NSAlert()
    question.messageText = "Unpair this Mac from KOS?"
    question.informativeText = "KOS will not reach this Mac again until you pair it anew."
    question.addButton(withTitle: "Unpair")
    question.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    if question.runModal() == .alertFirstButtonReturn { forget(sayRemoved: false) }
  }

  private func forget(sayRemoved: Bool) {
    controller.stop()
    connection.stop()
    PairingStore.clear()
    pairing = nil
    menu.refresh()
    if sayRemoved { alert("This Mac was removed from KOS.", "Pair it again from Settings, Devices in KOS to use it.") }
  }

  // MARK: Settings

  private func setAskFirst(_ on: Bool) {
    guard !on else {
      settings.askFirst = true
      return menu.refresh()
    }
    let question = NSAlert()
    question.messageText = "Let KOS start sessions without asking here?"
    question.informativeText =
      "Sessions will start when you approve them in KOS's approval queue instead, for when you are away from this Mac. The border, the bar and Stop still show for every session."
    question.addButton(withTitle: "Stop asking here")
    question.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    if question.runModal() == .alertFirstButtonReturn { settings.askFirst = false }
    menu.refresh()
  }

  // MARK: State

  private func currentState() -> DeviceState {
    DeviceState(consent: settings.consent, permissions: SystemPermissions.current(), displays: Displays.info())
  }

  private func reportStateIfChanged() {
    let now = currentState()
    guard connection.isProven, now != lastState, let message = try? Outbound.state(now) else { return }
    lastState = now
    connection.send(message)
  }

  private func alert(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
}
