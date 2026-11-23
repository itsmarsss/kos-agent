import AppKit
import DeviceCore
import DeviceLink
import DeviceUI
import SwiftUI

/// The menu bar item: what KOS is at (idle, working at a step, waiting on the owner, paused while they have the
/// Mac), what can be done about it with Stop always there, where KOS for Mac stands with each KOS, and the window.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
  struct Snapshot {
    /// Each KOS this Mac is paired with, by name, and its line.
    var kos: [(name: String, link: Connection.Status)]
    var session: LiveSession?
    /// What KOS is at, on this Mac and in the chat window.
    var turn: MenuTurn
    /// The session's time left beside the icon.
    var timeInMenuBar: Bool
  }

  var snapshot: () -> Snapshot
  var onOpen: (() -> Void)?
  /// The chat window, as ⌥⌘K opens it.
  var onChat: (() -> Void)?
  /// What the owner copied, sent into the chat window's chat as their message.
  var onSendClipboard: (() -> Void)?
  /// Each of these acts on every KOS it can: one at a time is the window's.
  var onReconnect: (() -> Void)?
  var onConnect: (() -> Void)?
  var onDisconnect: (() -> Void)?
  var onPause: (() -> Void)?
  var onResume: (() -> Void)?
  var onStop: (() -> Void)?
  var onExtend: (() -> Void)?
  /// An approval decided from the menu, by its id.
  var onDecide: ((String, Bool) -> Void)?

  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()
  /// Open now: keys go to the menu while it is, so a secret is never typed then.
  private(set) var isOpen = false

  init(snapshot: @escaping () -> Snapshot) {
    self.snapshot = snapshot
    super.init()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    refresh()
  }

  /// Redraws the icon and the words beside it; the menu itself is built fresh each time it opens.
  func refresh() {
    let now = snapshot()
    let image: NSImage?
    var tint: NSColor?
    switch now.turn.state {
    case .idle:
      let connected = now.kos.contains { if case .connected = $0.link { return true } else { return false } }
      image = NSImage(systemSymbolName: connected ? "cursorarrow" : "cursorarrow.slash", accessibilityDescription: "KOS for Mac")
    case .working:
      image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "KOS for Mac, working")
      tint = Palette.accent
    case .paused:
      image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "KOS for Mac, paused: you have control")
      tint = Palette.amber
    case .waiting:
      image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "KOS for Mac, waiting on you").map { Self.badged($0, Palette.amber) }
    }
    image?.isTemplate = tint == nil && now.turn.state == .idle
    item.button?.image = image
    item.button?.contentTintColor = tint
    let left = now.timeInMenuBar ? now.session.map { Self.left(until: $0.until) } : nil
    let words = now.turn.title ?? left
    item.length = words == nil ? NSStatusItem.squareLength : NSStatusItem.variableLength
    item.button?.title = words.map { " \($0)" } ?? ""
    item.button?.imagePosition = words == nil ? .imageOnly : .imageLeading
  }

  /// The icon with a dot of `colour` at its top right: something waits on the owner.
  private static func badged(_ symbol: NSImage, _ colour: NSColor) -> NSImage {
    let size = symbol.size
    let badged = NSImage(size: size, flipped: false) { rect in
      let tinted = symbol.withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [colour])) ?? symbol
      tinted.draw(in: rect)
      let dot = min(size.width, size.height) * 0.42
      colour.setFill()
      NSBezierPath(ovalIn: CGRect(x: rect.maxX - dot, y: rect.maxY - dot, width: dot, height: dot)).fill()
      return true
    }
    badged.isTemplate = false
    return badged
  }

  /// Time left, as short as the menu bar wants it: "12m", "1h 05m".
  static func left(until: Date, now: Date = Date()) -> String {
    let minutes = max(1, Int((until.timeIntervalSince(now) / 60).rounded(.up)))
    return minutes < 60 ? "\(minutes)m" : String(format: "%dh %02dm", minutes / 60, minutes % 60)
  }

  func menuWillOpen(_ menu: NSMenu) {
    isOpen = true
  }

  func menuDidClose(_ menu: NSMenu) {
    isOpen = false
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let now = snapshot()
    if now.kos.isEmpty {
      menu.addItem(info("Not paired with KOS"))
    } else {
      for kos in now.kos { menu.addItem(info(Self.line(kos.name, kos.link))) }
    }
    if now.turn.state != .idle {
      menu.insertItem(turnItem(now.turn), at: 0)
      menu.insertItem(.separator(), at: 1)
    }
    menu.addItem(.separator())
    let links = now.kos.map(\.link)
    let several = links.count > 1
    if links.contains(where: Self.redialable) { menu.addItem(action(several ? "Try all now" : "Try now", #selector(reconnect))) }
    if links.contains(.disconnected) { menu.addItem(action(several ? "Connect All" : "Connect", #selector(connect))) }
    if links.contains(where: { $0 != .disconnected }) { menu.addItem(action(several ? "Disconnect All" : "Disconnect", #selector(disconnect))) }
    // Pairing, permissions, each KOS's rules and the hidden apps all live in the one window.
    if !now.kos.isEmpty {
      let chat = action("Chat with KOS", #selector(openChat))
      chat.keyEquivalent = "k"
      chat.keyEquivalentModifierMask = [.command, .option]
      menu.addItem(chat)
      menu.addItem(action("Send Clipboard to KOS", #selector(sendClipboard)))
    }
    menu.addItem(action(now.kos.isEmpty ? "Pair with KOS…" : "Open KOS for Mac…", #selector(open)))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit KOS for Mac", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  }

  /// A line that dropped or was taken, which Try now dials again.
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
    case .replaced: words = "Connected from another copy of KOS for Mac"
    case .outdated: words = "Speaks a newer protocol. Update KOS for Mac."
    case .disconnected: words = "Disconnected"
    }
    return "\(name): \(words)"
  }

  /// The turn at the head of the menu, in KOS's own rows: each closes the menu as it acts.
  private func turnItem(_ turn: MenuTurn) -> NSMenuItem {
    var actions = MenuTurnActions()
    let close = { [weak self] (act: () -> Void) in
      self?.menu.cancelTracking()
      act()
    }
    actions.approve = { [weak self] id in close { self?.onDecide?(id, true) } }
    actions.deny = { [weak self] id in close { self?.onDecide?(id, false) } }
    actions.openChat = { [weak self] in close { self?.onChat?() } }
    actions.takeOver = { [weak self] in close { self?.onPause?() } }
    actions.handBack = { [weak self] in close { self?.onResume?() } }
    actions.extend = { [weak self] in close { self?.onExtend?() } }
    actions.stop = { [weak self] in close { self?.onStop?() } }
    let host = NSHostingView(rootView: TurnMenu(turn: turn, actions: actions))
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    let item = NSMenuItem()
    item.view = host
    return item
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
  @objc private func openChat() { onChat?() }
  @objc private func sendClipboard() { onSendClipboard?() }
  @objc private func reconnect() { onReconnect?() }
  @objc private func connect() { onConnect?() }
  @objc private func disconnect() { onDisconnect?() }
}
