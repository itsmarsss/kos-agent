import AppKit
import SwiftUI

/// What KOS Device's window shows, filled by the app. The view only reads it
/// and calls the actions; nothing here reaches the system.

/// Where the line to one KOS stands.
public enum LinkState: Equatable {
  case connecting
  case connected
  case offline(String)
  /// The far end could not sign with the key pinned at pairing.
  case untrusted
  /// Another copy of KOS Device took the line.
  case replaced
  case outdated
  /// The owner disconnected on purpose.
  case disconnected
}

public enum HomePage: Equatable {
  case home, settings
}

/// Opening at login, as macOS has it.
public enum LoginState: Equatable {
  case on, off
  /// Waiting for the owner to allow it under Login Items.
  case needsApproval
}

/// What of the owner's own hand pauses KOS.
public enum Takeover: String, CaseIterable, Sendable {
  /// Any movement of the pointer, however small.
  case anyMove
  /// A move as far as a deliberate one goes; a nudge does not.
  case deliberate
  /// Only a click, a scroll or a key; moving the pointer never pauses.
  case clicksAndKeys

  public var label: String {
    switch self {
    case .anyMove: return "Any move"
    case .deliberate: return "A real move"
    case .clicksAndKeys: return "Clicks and keys"
    }
  }
}

/// How KOS moves the pointer: so the owner can follow it, or quickly.
public enum Pace: String, CaseIterable, Sendable {
  case shown, quick

  public var label: String { self == .shown ? "Show each move" : "Quick" }
}

public enum Grant: CaseIterable, Hashable {
  case screen, input

  var title: String {
    switch self {
    case .screen: return "Screen Recording"
    case .input: return "Accessibility"
    }
  }

  var detail: String {
    switch self {
    case .screen: return "Shows KOS the screen it is working on."
    case .input: return "Moves the pointer and types, and notices when you take over."
    }
  }

  var icon: String {
    switch self {
    case .screen: return "rectangle.dashed.badge.record"
    case .input: return "cursorarrow.click.2"
    }
  }

  /// Its switch in System Settings, where it is turned off as easily as on.
  var settings: URL {
    let pane = self == .screen ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
  }
}

public struct AppEntry: Identifiable, Equatable {
  public let id: String
  public let name: String
  public let icon: NSImage?
  /// On this Mac now. A hidden app that is not stays hidden, should it arrive.
  public let installed: Bool
  /// Open now.
  public let running: Bool

  public init(id: String, name: String, icon: NSImage?, installed: Bool = true, running: Bool = false) {
    self.id = id
    self.name = name
    self.icon = icon
    self.installed = installed
    self.running = running
  }
}

/// One KOS this Mac is paired with, as its card shows it.
public struct KOSEntry: Identifiable, Equatable {
  /// This Mac's device id in that KOS.
  public let id: String
  /// Its address as the owner reads it.
  public let host: String
  public let dashboard: URL?
  /// What this Mac is called there.
  public let deviceName: String
  public let link: LinkState
  /// Sessions from this KOS are allowed here, each time.
  public let askFirst: Bool

  public init(id: String, host: String, dashboard: URL?, deviceName: String, link: LinkState, askFirst: Bool) {
    self.id = id
    self.host = host
    self.dashboard = dashboard
    self.deviceName = deviceName
    self.link = link
    self.askFirst = askFirst
  }
}

public struct SessionSummary: Equatable {
  public let task: String
  public let requester: String
  /// Which KOS it is for, when there are several.
  public let kos: String?
  /// The chat that asked, on the dashboard.
  public let chat: URL?
  public let until: Date
  public let paused: Bool

  public init(task: String, requester: String, kos: String? = nil, chat: URL? = nil, until: Date, paused: Bool) {
    self.task = task
    self.requester = requester
    self.kos = kos
    self.chat = chat
    self.until = until
    self.paused = paused
  }
}

public struct HomeActions {
  public var pair: () -> Void = {}
  /// Each by the KOS's id.
  public var unpair: (String) -> Void = { _ in }
  public var reconnect: (String) -> Void = { _ in }
  public var connect: (String) -> Void = { _ in }
  public var disconnect: (String) -> Void = { _ in }
  public var setAskFirst: (String, Bool) -> Void = { _, _ in }
  /// Read the pairing from the Keychain again, after it refused.
  public var retryKeychain: () -> Void = {}
  public var grant: (Grant) -> Void = { _ in }
  public var hide: (String) -> Void = { _ in }
  public var unhide: (String) -> Void = { _ in }
  public var pause: () -> Void = {}
  public var resume: () -> Void = {}
  public var stop: () -> Void = {}
  public var restart: () -> Void = {}
  public var close: () -> Void = {}
  public var minimize: () -> Void = {}
  public var setLongest: (Int) -> Void = { _ in }
  public var setPromptWait: (Int) -> Void = { _ in }
  public var setIdle: (Int) -> Void = { _ in }
  public var setOpenAtLogin: (Bool) -> Void = { _ in }
  public var openLoginItems: () -> Void = {}
  public var setConnectWhenOpened: (Bool) -> Void = { _ in }
  public var setTakeover: (Takeover) -> Void = { _ in }
  public var setPace: (Pace) -> Void = { _ in }
  public var setSounds: (Bool) -> Void = { _ in }
  public var setTimeInMenuBar: (Bool) -> Void = { _ in }
  /// This run's log onto the clipboard, to send.
  public var copyLog: () -> Void = {}

  public init() {}
}

@MainActor
public final class HomeModel: ObservableObject {
  /// Every KOS this Mac is paired with, in the order they were paired.
  @Published public var kos: [KOSEntry] = []
  /// The Devices page of the KOS being typed in, while pairing.
  @Published public var devicesPage: URL?
  @Published public var session: SessionSummary?
  /// The Keychain would not give up the pairing: why, until a try succeeds.
  @Published public var keychainProblem: String?
  @Published public var screenGranted = false
  @Published public var inputGranted = false
  /// A grant asked for once: the next press goes to its switch in System Settings.
  @Published public var asked: Set<Grant> = []
  @Published public var hidden: [AppEntry] = []
  /// Apps that could be hidden: those installed and those open, not hidden yet.
  @Published public var pickable: [AppEntry] = []

  // The pairing form.
  @Published public var showPairing = false
  @Published public var address = ""
  @Published public var code = ""
  @Published public var name = ""
  @Published public var note = ""
  @Published public var noteFailed = false
  @Published public var busy = false

  @Published public var page: HomePage = .home

  // The owner's settings for this Mac, and what each may be.
  @Published public var longestMinutes = 60
  @Published public var promptWaitSeconds = 60
  @Published public var idleMinutes = 3
  @Published public var openAtLogin: LoginState = .off
  @Published public var connectWhenOpened = true
  @Published public var takeover: Takeover = .deliberate
  @Published public var pace: Pace = .shown
  @Published public var sounds = true
  @Published public var timeInMenuBar = true
  /// The log was just copied: the button says so for a moment.
  @Published public var logCopied = false
  public var longestChoices = [15, 30, 60, 120, 240, 480]
  public var promptWaitChoices = [30, 60, 120, 300]
  public var idleChoices = [1, 3, 5, 10, 15]

  public var actions = HomeActions()

  /// How KOS Device keeps the Mac safe, in the repository's own words.
  public static let safety = URL(string: "https://github.com/itsmarsss/kos-agent/blob/main/docs/computer.md#security-model")!

  public init() {}

  public func granted(_ grant: Grant) -> Bool {
    grant == .screen ? screenGranted : inputGranted
  }

  public var allGranted: Bool { screenGranted && inputGranted }

  /// Screen Recording was asked for and is not seen yet: macOS applies it on a fresh start.
  public var needsRestart: Bool { asked.contains(.screen) && !screenGranted }

  /// The pairing form is up: nothing is paired yet, or another KOS is being added.
  public var pairing: Bool { kos.isEmpty || showPairing }

  /// Where this Mac stands with KOS as a whole: the best of its lines.
  public var overall: LinkState? {
    let links = kos.map(\.link)
    if links.contains(.connected) { return .connected }
    if links.contains(.connecting) { return .connecting }
    return links.first { $0 != .disconnected } ?? links.first
  }
}
