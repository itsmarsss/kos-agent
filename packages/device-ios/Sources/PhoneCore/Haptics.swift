import Foundation

#if os(iOS)
import UIKit
#endif

/// What the phone's hand feels: a press, something asking for the owner, a thing done.
@MainActor
public protocol Haptics {
  func tap()
  func attention()
  func done()
}

/// Felt on an iPhone; nothing anywhere else.
@MainActor
public struct SystemHaptics: Haptics {
  public init() {}

  public func tap() {
    #if os(iOS)
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    #endif
  }

  public func attention() {
    #if os(iOS)
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
    #endif
  }

  public func done() {
    #if os(iOS)
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    #endif
  }
}
