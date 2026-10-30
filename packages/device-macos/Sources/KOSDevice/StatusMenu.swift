import AppKit
import DeviceCore

/// The menu bar item: where KOS Device is, the live session with Pause and Stop, and the owner's settings.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
  struct Snapshot {
    var paired: Pairing?
    var link: Connection.Status
    var session: LiveSession?
    var askFirst: Bool
  }

  var snapshot: () -> Snapshot
  var onPair: (() -> Void)?
  var onUnpair: (() -> Void)?
  var onReconnect: (() -> Void)?
  var onPause: (() -> Void)?
  var onResume: (() -> Void)?
  var onStop: (() -> Void)?
  var onAskFirst: ((Bool) -> Void)?
  var onHiddenApps: (() -> Void)?
  var onPermissions: (() -> Void)?

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
    switch (now.session, now.link) {
    case (let session?, _):
      symbol = "cursorarrow.rays"
      tint = session.paused ? Palette.amber : Palette.accent
    case (nil, .connected):
      symbol = "cursorarrow"
    default:
      symbol = "cursorarrow.slash"
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "KOS Device")
    image?.isTemplate = tint == nil
    item.button?.image = image
    item.button?.contentTintColor = tint
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let now = snapshot()
    menu.addItem(info(statusLine(now)))
    if let session = now.session {
      menu.addItem(.separator())
      menu.addItem(info(session.paused ? "Paused: \(session.task)" : "Using this Mac: \(session.task)"))
      menu.addItem(action(session.paused ? "Resume" : "Pause", session.paused ? #selector(resume) : #selector(pause)))
      menu.addItem(action("Stop", #selector(stop)))
    }
    menu.addItem(.separator())
    if now.paired == nil {
      menu.addItem(action("Pair with KOS…", #selector(pair)))
    } else {
      switch now.link {
      case .offline, .replaced, .untrusted: menu.addItem(action("Reconnect", #selector(reconnect)))
      case .connecting, .connected, .outdated: break
      }
      menu.addItem(action("Pair again…", #selector(pair)))
      menu.addItem(action("Unpair…", #selector(unpair)))
    }
    let ask = action("Ask before each session", #selector(toggleAsk))
    ask.state = now.askFirst ? .on : .off
    menu.addItem(ask)
    menu.addItem(action("Hidden apps…", #selector(hiddenApps)))
    menu.addItem(action("Permissions…", #selector(permissions)))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit KOS Device", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  }

  private func statusLine(_ now: Snapshot) -> String {
    guard let paired = now.paired else { return "Not paired with KOS" }
    let place = (try? paired.kosAddress().display) ?? paired.address
    switch now.link {
    case .connecting: return "Connecting to \(place)…"
    case .connected(let name): return "Connected to KOS as \(name)"
    case .offline(let reason): return "Offline: \(reason)"
    case .untrusted: return "This KOS could not prove who it is"
    case .replaced: return "Connected from another copy of KOS Device"
    case .outdated: return "KOS speaks a newer protocol. Update KOS Device."
    }
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

  @objc private func pair() { onPair?() }
  @objc private func unpair() { onUnpair?() }
  @objc private func reconnect() { onReconnect?() }
  @objc private func pause() { onPause?() }
  @objc private func resume() { onResume?() }
  @objc private func stop() { onStop?() }
  @objc private func toggleAsk() { onAskFirst?(!snapshot().askFirst) }
  @objc private func hiddenApps() { onHiddenApps?() }
  @objc private func permissions() { onPermissions?() }
}
