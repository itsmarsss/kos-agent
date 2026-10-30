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

  private enum Key {
    static let askFirst = "askBeforeEachSession"
    static let hiddenApps = "hiddenApps"
  }

  private let defaults: UserDefaults
  /// Told whenever a setting changes, so KOS hears the new consent and captures leave the right apps out.
  var onChange: (() -> Void)?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    defaults.register(defaults: [Key.askFirst: true, Key.hiddenApps: Self.defaultHiddenApps])
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
