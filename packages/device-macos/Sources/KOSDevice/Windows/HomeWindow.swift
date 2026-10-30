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
  private var watches: [AnyCancellable] = []
  /// Apps installed on this Mac, by bundle id, found when the window opens.
  private var installed: Set<String> = []
  /// Each app's entry, made once, so the lists keep the same icons and compare equal.
  private var entries: [String: AppEntry] = [:]

  init(settings: Settings) {
    self.settings = settings
    super.init()
    model.name = Host.current().localizedName ?? "Mac"
    model.longestChoices = Durations.longestChoices
    model.promptWaitChoices = Settings.promptWaitChoices
    model.idleChoices = Settings.idleChoices
    model.actions.pair = { [weak self] in self?.pair() }
    model.actions.grant = { [weak self] grant in self?.grant(grant) }
    model.actions.restart = { SystemPermissions.relaunch() }
    model.actions.hide = { [weak self] id in self?.settings.hiddenApps.append(id) }
    model.actions.unhide = { [weak self] id in self?.settings.hiddenApps.removeAll { $0.caseInsensitiveCompare(id) == .orderedSame } }
    model.actions.close = { [weak self] in self?.window.performClose(nil) }
    model.actions.minimize = { [weak self] in self?.window.miniaturize(nil) }
    watches = [
      // A pasted pairing link fills the address and the code.
      model.$address.sink { [weak self] text in self?.readLink(text) },
      // The window follows the content's height, top edge fixed, so a card opening slides rather than jumps.
      model.$contentHeight.removeDuplicates().sink { [weak self] height in self?.fit(height) },
    ]
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
    findInstalledApps()
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
    model.longestMinutes = settings.longestMinutes
    model.promptWaitSeconds = settings.promptWaitSeconds
    model.idleMinutes = settings.idleMinutes
    model.connectWhenOpened = settings.connectWhenOpened
    let login: LoginState = switch LaunchAtLogin.state {
    case .on: .on
    case .off: .off
    case .needsApproval: .needsApproval
    }
    if login != model.openAtLogin { model.openAtLogin = login }
    let hidden = settings.hiddenApps.map { entry($0, running: false) }
    if hidden != model.hidden { model.hidden = hidden }
    let running = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap(\.bundleIdentifier))
    let mine = Bundle.main.bundleIdentifier
    let pickable = installed.union(running)
      .filter { $0 != mine && !settings.isHidden($0) }
      .map { entry($0, running: running.contains($0)) }
      .sorted { a, b in a.running != b.running ? a.running : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending }
    if pickable != model.pickable { model.pickable = pickable }
  }

  /// Every app in the usual places, read off the main thread; the picker lists them as they arrive.
  private func findInstalledApps() {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let places = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
      .map { URL(fileURLWithPath: $0) } + [home.appendingPathComponent("Applications")]
    Task.detached(priority: .utility) {
      var found: Set<String> = []
      for place in places {
        let apps = (try? FileManager.default.contentsOfDirectory(at: place, includingPropertiesForKeys: nil)) ?? []
        for app in apps where app.pathExtension == "app" {
          if let id = Bundle(url: app)?.bundleIdentifier { found.insert(id) }
        }
      }
      let apps = found
      await MainActor.run { [weak self] in
        guard let self, apps != self.installed else { return }
        self.installed = apps
        self.refreshSystem()
      }
    }
  }

  private func fit(_ height: CGFloat) {
    guard height > 0 else { return }
    let frame = window.frame
    let content = window.contentRect(forFrameRect: frame)
    let target = window.frameRect(forContentRect: CGRect(x: content.minX, y: content.maxY - height, width: content.width, height: height))
    guard abs(target.height - frame.height) > 0.5 else { return }
    if window.isVisible {
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.32
        context.timingFunction = CAMediaTimingFunction(controlPoints: 0.25, 0.9, 0.3, 1)
        window.animator().setFrame(target, display: true)
      }
    } else {
      window.setFrame(target, display: false)
    }
  }

  // MARK: Pairing

  private func readLink(_ text: String) {
    let typed = text.trimmingCharacters(in: .whitespaces)
    model.devicesPage = typed.isEmpty ? nil : (try? KOSAddress(typed))?.devicesPage
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
    let host = NSHostingView(rootView: HomeView(model: model))
    // The window's size is set from the content's height, animated; the host must not fight it.
    host.sizingOptions = []
    let window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 460, height: max(model.contentHeight, 600)),
      styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.contentView = host
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    // KOS's own lights are drawn in the window; the system's would sit on top of them.
    for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      window.standardWindowButton(button)?.isHidden = true
    }
    window.title = "KOS Device"
    window.isMovableByWindowBackground = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(srgbRed: 0x0C / 255, green: 0x0E / 255, blue: 0x12 / 255, alpha: 1)
    window.isReleasedWhenClosed = false
    window.delegate = self
    return window
  }

  /// An app's entry: its name and icon looked up once, its open state as of now.
  private func entry(_ bundleId: String, running: Bool) -> AppEntry {
    let known = entries[bundleId] ?? Self.lookUp(bundleId)
    entries[bundleId] = known
    guard known.running != running else { return known }
    let now = AppEntry(id: known.id, name: known.name, icon: known.icon, installed: known.installed, running: running)
    entries[bundleId] = now
    return now
  }

  private static func lookUp(_ bundleId: String) -> AppEntry {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
      let name = Settings.knownNames[bundleId] ?? bundleId.split(separator: ".").last.map(String.init) ?? bundleId
      return AppEntry(id: bundleId, name: name, icon: nil, installed: false)
    }
    let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    return AppEntry(id: bundleId, name: name, icon: NSWorkspace.shared.icon(forFile: url.path))
  }
}
