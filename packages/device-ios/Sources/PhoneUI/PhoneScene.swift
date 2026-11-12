import PhoneCore
import SwiftUI

/// KOS for iPhone's one window, over the phone's own adapters: on an iPhone,
/// the Keychain, its speech recognition and its haptics; on a Mac, where the
/// app is run only to be looked at, pairings in memory and no microphone.
public struct PhoneScene: Scene {
  @StateObject private var phone = Phone.onThisDevice()

  public init() {}

  public var body: some Scene {
    WindowGroup {
      PhoneRoot(phone: phone)
        .onOpenURL { url in Task { await phone.pairing.open(url) } }
        .onAppear { phone.start() }
      #if os(macOS)
        .frame(width: 390, height: 844)
      #endif
    }
    #if os(macOS)
    .windowResizability(.contentSize)
    #endif
  }
}
