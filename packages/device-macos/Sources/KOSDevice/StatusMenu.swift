import AppKit
import DeviceCore

/// The menu bar item: where KOS Device stands with each KOS, the live session with Pause and Stop, and the window.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
  struct Snapshot {
    /// Each KOS this Mac is paired with, by name, and its line.
    var kos: [(name: String, link: Connection.Status)]
    var session: LiveSession?
    /// Which KOS the session is for, when there are several.
    var sessionKOS: String?
    /// The session's time left beside the icon.
    var timeInMenuBar: Bool
  }

  var snapshot: () -> Snapshot
  var onOpen: (() -> Void)?
  /// Each of these acts on every KOS it can: one at a time is the window's.
  var onReconnect: (() -> Void)?
  var onConnect: (() -> Void)?
  var onDisconnect: (() -> Void)?
  var onPause: (() -> Void)?
  var onResume: (() -> Void)?
  var onStop: (() -> Void)?
  var onExtend: (() -> Void)?

  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()

  init(snapshot: @escaping () -> Snapshot) {
    self.snapshot = snapshot
    super.init()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    refresh()
  }

  /// Redraws the icon; the menu itself is built fresh each time it opens.
  func refresh() {
    let now = snapshot()
    let symbol: String
    var tint: NSColor?
    if let session = now.session {
      symbol = "cursorarrow.rays"
      tint = session.paused ? Palette.amber : Palette.accent
    } else if now.kos.contains(where: { if case .connected = $0.link { return true } else { return false } }) {
      symbol = "cursorarrow"
    } else {
      symbol = "cursorarrow.slash"
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "KOS Device")
    image?.isTemplate = tint == nil
    item.button?.image = image
    item.button?.contentTintColor = tint
    let left = now.timeInMenuBar ? now.session.map { Self.left(until: $0.until) } : nil
    item.length = left == nil ? NSStatusItem.squareLength : NSStatusItem.variableLength
    item.button?.title = left.map { " \($0)" } ?? ""
    item.button?.imagePosition = left == nil ? .imageOnly : .imageLeading
  }

  /// Time left, as short as the menu bar wants it: "12m", "1h 05m".
  static func left(until: Date, now: Date = Date()) -> String {
    let minutes = max(1, Int((until.timeIntervalSince(now) / 60).rounded(.up)))
    return minutes < 60 ? "\(minutes)m" : String(format: "%dh %02dm", minutes / 60, minutes % 60)
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let now = snapshot()
    if now.kos.isEmpty {
      menu.addItem(info("Not paired with KOS"))
    } else {
      for kos in now.kos { menu.addItem(info(Self.line(kos.name, kos.link))) }
    }
    if let session = now.session {
      menu.addItem(.separator())
      let task = session.paused ? "Paused: \(session.task)" : "Using this Mac: \(session.task)"
      menu.addItem(info(now.sessionKOS.map { "\(task), for \($0)" } ?? task))
      menu.addItem(action(session.paused ? "Resume" : "Pause", session.paused ? #selector(resume) : #selector(pause)))
      menu.addItem(action("Give it 15 more minutes", #selector(extend)))
      menu.addItem(action("Stop", #selector(stop)))
    }
    menu.addItem(.separator())
    let links = now.kos.map(\.link)
    let several = links.count > 1
    if links.contains(where: Self.redialable) { menu.addItem(action(several ? "Reconnect All" : "Reconnect", #selector(reconnect))) }
    if links.contains(.disconnected) { menu.addItem(action(several ? "Connect All" : "Connect", #selector(connect))) }
    if links.contains(where: { $0 != .disconnected }) { menu.addItem(action(several ? "Disconnect All" : "Disconnect", #selector(disconnect))) }
    // Pairing, permissions, each KOS's rules and the hidden apps all live in the one window.
    menu.addItem(action(now.kos.isEmpty ? "Pair with KOS…" : "Open KOS Device…", #selector(open)))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit KOS Device", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  }

  /// A line that dropped or was taken, which Reconnect dials again.
  static func redialable(_ link: Connection.Status) -> Bool {
    switch link {
    case .offline, .replaced, .untrusted: return true
    default: return false
    }
  }

  /// One KOS's line, in words.
  private static func line(_ name: String, _ link: Connection.Status) -> String {
    let words: String
    switch link {
    case .connecting: words = "Connecting…"
    case .connected(let deviceName): words = "Connected as \(deviceName)"
    case .offline(let reason): words = "Offline: \(reason)"
    case .untrusted: words = "Could not prove it is KOS"
    case .replaced: words = "Connected from another copy of KOS Device"
    case .outdated: words = "Speaks a newer protocol. Update KOS Device."
    case .disconnected: words = "Disconnected"
    }
    return "\(name): \(words)"
  }

  private func info(_ text: String) -> NSMenuItem {
    let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    item.target = self
    return item
  }

  @objc private func open() { onOpen?() }
  @objc private func reconnect() { onReconnect?() }
  @objc private func pause() { onPause?() }
  @objc private func resume() { onResume?() }
  @objc private func stop() { onStop?() }
  @objc private func extend() { onExtend?() }
  @objc private func connect() { onConnect?() }
  @objc private func disconnect() { onDisconnect?() }
}
