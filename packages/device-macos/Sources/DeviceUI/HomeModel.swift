import AppKit
import SwiftUI

/// What KOS Device's window shows, filled by the app. The view only reads it
/// and calls the actions; nothing here reaches the system.

public enum LinkState: Equatable {
  case notPaired
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

public struct SessionSummary: Equatable {
  public let task: String
  public let requester: String
  /// The chat that asked, on the dashboard.
  public let chat: URL?
  public let until: Date
  public let paused: Bool

  public init(task: String, requester: String, chat: URL? = nil, until: Date, paused: Bool) {
    self.task = task
    self.requester = requester
    self.chat = chat
    self.until = until
    self.paused = paused
  }
}

public struct HomeActions {
  public var pair: () -> Void = {}
  public var unpair: () -> Void = {}
  public var reconnect: () -> Void = {}
  public var grant: (Grant) -> Void = { _ in }
  public var setAskFirst: (Bool) -> Void = { _ in }
  public var hide: (String) -> Void = { _ in }
  public var unhide: (String) -> Void = { _ in }
  public var pause: () -> Void = {}
  public var resume: () -> Void = {}
  public var stop: () -> Void = {}
  public var restart: () -> Void = {}
  public var close: () -> Void = {}
  public var minimize: () -> Void = {}
  public var connect: () -> Void = {}
  public var disconnect: () -> Void = {}
  public var setLongest: (Int) -> Void = { _ in }
  public var setPromptWait: (Int) -> Void = { _ in }
  public var setIdle: (Int) -> Void = { _ in }
  public var setOpenAtLogin: (Bool) -> Void = { _ in }
  public var openLoginItems: () -> Void = {}
  public var setConnectWhenOpened: (Bool) -> Void = { _ in }

  public init() {}
}

@MainActor
public final class HomeModel: ObservableObject {
  @Published public var link: LinkState = .notPaired
  /// KOS's address as the owner reads it, once paired.
  @Published public var host: String?
  /// The dashboard, once paired.
  @Published public var dashboard: URL?
  /// The Devices page of the KOS being typed in, while pairing.
  @Published public var devicesPage: URL?
  /// This Mac's name in KOS, once paired.
  @Published public var deviceName: String?
  @Published public var session: SessionSummary?
  @Published public var screenGranted = false
  @Published public var inputGranted = false
  /// A grant asked for once: the next press goes to its switch in System Settings.
  @Published public var asked: Set<Grant> = []
  @Published public var askFirst = true
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

  /// The content's natural height, for the window to follow, animated.
  @Published public var contentHeight: CGFloat = 0

  @Published public var page: HomePage = .home

  // The owner's settings for this Mac, and what each may be.
  @Published public var longestMinutes = 60
  @Published public var promptWaitSeconds = 60
  @Published public var idleMinutes = 3
  @Published public var openAtLogin: LoginState = .off
  @Published public var connectWhenOpened = true
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

  /// Pairing, rather than standing paired.
  public var pairing: Bool { link == .notPaired || showPairing }
}
