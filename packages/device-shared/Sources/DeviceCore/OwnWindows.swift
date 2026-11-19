import Foundation

/// One on-screen window under a point, topmost first, as the window server lists them.
public struct WindowHit: Equatable, Sendable {
  public let pid: Int32
  public let number: Int
  /// Fully transparent: the window server passes clicks through it.
  public let clear: Bool

  public init(pid: Int32, number: Int, clear: Bool = false) {
    self.pid = pid
    self.number = number
    self.clear = clear
  }
}

/// Where a pointer action at a point lands, KOS for Mac's own windows counted.
public enum Landing: Equatable, Sendable {
  /// On another app's window, by its pid.
  case app(Int32)
  /// On one of KOS for Mac's own windows that takes the click: its menu bar item, its menu, the Home window, a
  /// panel or an alert. KOS never acts there, since a picture leaves them out and an approval can be decided there.
  case own
  /// On no window at all: the desktop.
  case nothing

  /// The first window under the point that takes the click. KOS for Mac's own windows are skipped only where they
  /// let KOS's pointer through (`passes`: the overlay, the bar and the chat window while it acts); any other of its
  /// windows is where the click lands, the menu bar's status item included.
  public static func of(_ hits: [WindowHit], me: Int32, passes: (Int) -> Bool) -> Landing {
    for hit in hits {
      if hit.pid == me {
        if passes(hit.number) { continue }
        return .own
      }
      if hit.clear { continue }
      return .app(hit.pid)
    }
    return .nothing
  }

  /// The refusal for an action landing on KOS for Mac's own window.
  public static var ownRefusal: DeviceError {
    DeviceError(.target, "That is KOS for Mac's own menu or window, where approvals and settings are decided; KOS never acts there.")
  }
}

/// Key combinations that reach KOS for Mac's own menu or windows from any app, refused whatever is in front: moving
/// the keyboard into the menu bar or its status menus, and the chat window's own ⌥⌘K.
public enum OwnKeys {
  /// Control-F2 and Control-F8, macOS's keys into the menu bar and its status menus; Option-Command-K.
  static let menuBar: UInt16 = 120
  static let statusMenus: UInt16 = 100
  static let chat: UInt16 = 40

  public static func refusal(_ combo: KeyCombo) -> DeviceError? {
    let mods = combo.modifiers.subtracting([.function, .numericPad])
    if mods.contains(.control), combo.code == menuBar || combo.code == statusMenus {
      return DeviceError(.target, "That moves the keyboard into the menu bar, where KOS for Mac's own menu is; KOS never presses it.")
    }
    if mods == [.option, .command], combo.code == chat {
      return DeviceError(.target, "That opens KOS for Mac's own window; KOS never presses it.")
    }
    return nil
  }
}
