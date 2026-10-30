import AppKit
import Combine
import DeviceCore
import DeviceUI
import SwiftUI

/// The window KOS Device opens: pairing, permissions and the owner's rules, in one place.
///
/// A pairing link fills the form, whether pasted or opened, but never pairs
/// by itself: any web page can open a link, and pairing with a KOS that is
/// not the owner's would let a stranger ask for this Mac. The owner reads
/// the address and presses Pair.
@MainActor
final class HomeWindow: NSObject, NSWindowDelegate {
  let model = HomeModel()
  /// Paired: keep this and dial it.
  var onPaired: ((Pairing) -> Void)?

  private let settings: Settings
  private lazy var window: NSWindow = makeWindow()
  private var refresher: Timer?
  private var addressWatch: AnyCancellable?

  init(settings: Settings) {
    self.settings = settings
    super.init()
    model.name = Host.current().localizedName ?? "Mac"
    model.actions.pair = { [weak self] in self?.pair() }
    model.actions.grant = { [weak self] grant in self?.grant(grant) }
    model.actions.restart = { SystemPermissions.relaunch() }
    model.actions.hide = { [weak self] id in self?.settings.hiddenApps.append(id) }
    model.actions.unhide = { [weak self] id in self?.settings.hiddenApps.removeAll { $0.caseInsensitiveCompare(id) == .orderedSame } }
    // A pasted pairing link fills the address and the code.
    addressWatch = model.$address.sink { [weak self] text in self?.readLink(text) }
  }

  var isVisible: Bool { window.isVisible }

  func show(prefill link: PairingLink? = nil) {
    if let link {
      model.showPairing = true
      model.address = link.address.base.absoluteString
      model.code = link.code
      say("Check this is your KOS, then press Pair.")
    } else if model.note.isEmpty {
      say("")
    }
    refreshSystem()
    refresher?.invalidate()
    refresher = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refreshSystem() }
    }
    NSApp.activate(ignoringOtherApps: true)
    if !window.isVisible { window.center() }
    window.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    refresher?.invalidate()
    refresher = nil
  }

  /// What macOS has granted and which apps are hidden or could be: read again while the window is open.
  func refreshSystem() {
    let now = SystemPermissions.current()
    model.screenGranted = now.screen
    model.inputGranted = now.input
    model.askFirst = settings.askFirst
    model.hidden = settings.hiddenApps.map(Self.entry)
    model.addable = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !settings.isHidden($0.bundleIdentifier) }
      .map { Self.entry($0.bundleIdentifier!) }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  // MARK: Pairing

  private func readLink(_ text: String) {
    guard let link = try? PairingLink.parse(text) else { return }
    model.address = link.address.base.absoluteString
    model.code = link.code
    say("Check this is your KOS, then press Pair.")
  }

  private func pair() {
    let link: PairingLink
    do {
      link = try PairingLink(address: KOSAddress(model.address), code: model.code)
    } catch let error as DeviceError {
      return say(error.message, failed: true)
    } catch {
      return say(error.localizedDescription, failed: true)
    }
    let label = model.name.trimmingCharacters(in: .whitespaces)
    model.busy = true
    say("Pairing with \(link.address.display)…")
    Task {
      defer { model.busy = false }
      do {
        let pairing = try await PairingClient.pair(link, name: label.isEmpty ? "Mac" : label)
        model.showPairing = false
        model.code = ""
        say("")
        onPaired?(pairing)
      } catch let error as DeviceError {
        say(error.message, failed: true)
      } catch {
        say(error.localizedDescription, failed: true)
      }
    }
  }

  private func say(_ text: String, failed: Bool = false) {
    model.note = text
    model.noteFailed = failed
  }

  // MARK: Permissions

  private func grant(_ grant: Grant) {
    let kind: SystemPermissions.Kind = grant == .screen ? .screen : .input
    // The first press puts KOS Device in the list with macOS's own prompt; after that, straight to the switch.
    if model.asked.insert(grant).inserted {
      SystemPermissions.request(kind)
    } else {
      SystemPermissions.openSettings(kind)
    }
    refreshSystem()
  }

  // MARK: Window

  private func makeWindow() -> NSWindow {
    let window = NSWindow(contentViewController: NSHostingController(rootView: HomeView(model: model)))
    window.styleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.title = "KOS Device"
    window.isMovableByWindowBackground = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(srgbRed: 0x0C / 255, green: 0x0E / 255, blue: 0x12 / 255, alpha: 1)
    window.isReleasedWhenClosed = false
    window.delegate = self
    return window
  }

  private static func entry(_ bundleId: String) -> AppEntry {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
      let name = Settings.knownNames[bundleId] ?? bundleId.split(separator: ".").last.map(String.init) ?? bundleId
      return AppEntry(id: bundleId, name: name, icon: nil, installed: false)
    }
    let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    return AppEntry(id: bundleId, name: name, icon: NSWorkspace.shared.icon(forFile: url.path))
  }
}
