#if os(iOS)
  import UIKit

  /// Which ways the app turns: upright, but while an artifact is open the viewer turns with the phone, so a deck on
  /// its side fills the screen a slide at a time. Info.plist allows every way but upside down; this narrows it.
  @MainActor
  public enum Orientation {
    static private(set) var allowed: UIInterfaceOrientationMask = .portrait

    /// The viewer opened or closed: it turns, or the app goes back upright.
    static func viewer(open: Bool) {
      allowed = open ? .allButUpsideDown : .portrait
      for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
        var top = scene.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        top?.setNeedsUpdateOfSupportedInterfaceOrientations()
        scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        if !open { scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) }
      }
    }
  }

  /// The app's delegate, for the one thing SwiftUI leaves to it: which ways it may turn now.
  public final class PhoneAppDelegate: NSObject, UIApplicationDelegate {
    public func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
      MainActor.assumeIsolated { Orientation.allowed }
    }
  }
#endif
