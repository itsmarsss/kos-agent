import DeviceCore
import Foundation

/// The owner's choices for this device, kept on this device.
///
/// Only the menu and windows here write them. There is no call in the
/// protocol that reaches this type, which is what "nothing KOS sends can
/// change the device's settings" rests on.
@MainActor
final class Settings {
  static let defaultHiddenApps = [
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.dashlane.Dashlane",
    "com.lastpass.LastPass",
  ]

  /// What the default hidden apps are called, for when one is not on this Mac to ask.
  static let knownNames = [
    "com.1password.1password": "1Password",
    "com.agilebits.onepassword7": "1Password 7",
    "com.bitwarden.desktop": "Bitwarden",
    "com.apple.keychainaccess": "Keychain Access",
    "com.apple.Passwords": "Passwords",
    "com.dashlane.Dashlane": "Dashlane",
    "com.lastpass.LastPass": "LastPass",
  ]

  private enum Key {
    static let askFirst = "askBeforeEachSession"
    static let hiddenApps = "hiddenApps"
    static let longest = "longestSessionMinutes"
    static let promptWait = "promptWaitSeconds"
    static let idle = "idleMinutes"
    static let connect = "connectWhenOpened"
  }

  static let promptWaitChoices = [30, 60, 120, 300]
  static let idleChoices = [1, 3, 5, 10, 15]

  private let defaults: UserDefaults
  /// Told whenever a setting changes, so KOS hears the new consent and captures leave the right apps out.
  var onChange: (() -> Void)?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    defaults.register(defaults: [
      Key.askFirst: true, Key.hiddenApps: Self.defaultHiddenApps, Key.longest: Durations.defaultLongest,
      Key.promptWait: 60, Key.idle: 3, Key.connect: true,
    ])
  }

  /// On: the owner allows each session here. Off: KOS's approval queue decides.
  var askFirst: Bool {
    get { defaults.bool(forKey: Key.askFirst) }
    set {
      defaults.set(newValue, forKey: Key.askFirst)
      onChange?()
    }
  }

  var consent: Consent { askFirst ? .device : .kos }

  /// The longest a session may run, whatever KOS asks for.
  var longestMinutes: Int {
    get { Self.oneOf(Durations.longestChoices, defaults.integer(forKey: Key.longest), else: Durations.defaultLongest) }
    set { store(newValue, in: Durations.longestChoices, key: Key.longest) }
  }

  /// How long the prompt waits for an answer before saying no.
  var promptWaitSeconds: Int {
    get { Self.oneOf(Self.promptWaitChoices, defaults.integer(forKey: Key.promptWait), else: 60) }
    set { store(newValue, in: Self.promptWaitChoices, key: Key.promptWait) }
  }

  /// How long a session may sit with nothing done before it ends.
  var idleMinutes: Int {
    get { Self.oneOf(Self.idleChoices, defaults.integer(forKey: Key.idle), else: 3) }
    set { store(newValue, in: Self.idleChoices, key: Key.idle) }
  }

  /// Dial KOS as soon as the app opens; off, it waits for Connect.
  var connectWhenOpened: Bool {
    get { defaults.bool(forKey: Key.connect) }
    set {
      defaults.set(newValue, forKey: Key.connect)
      onChange?()
    }
  }

  private func store(_ value: Int, in choices: [Int], key: String) {
    guard choices.contains(value) else { return }
    defaults.set(value, forKey: key)
    onChange?()
  }

  /// A stored choice, or the default when what is stored is not one of the choices.
  private static func oneOf(_ choices: [Int], _ value: Int, else fallback: Int) -> Int {
    choices.contains(value) ? value : fallback
  }

  /// Bundle ids KOS never sees and never acts on.
  var hiddenApps: [String] {
    get { defaults.stringArray(forKey: Key.hiddenApps) ?? [] }
    set {
      var seen = Set<String>()
      defaults.set(newValue.filter { seen.insert($0.lowercased()).inserted }, forKey: Key.hiddenApps)
      onChange?()
    }
  }

  func isHidden(_ bundleId: String?) -> Bool {
    guard let bundleId else { return false }
    return hiddenApps.contains { $0.caseInsensitiveCompare(bundleId) == .orderedSame }
  }
}
