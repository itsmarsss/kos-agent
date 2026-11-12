import PhoneCore
import SwiftUI

/// KOS for iPhone's one window, over the phone's own adapters: on an iPhone,
/// the Keychain, its speech recognition and its haptics; on a Mac, where the
/// app is run only to be looked at, pairings in memory and no microphone.
/// A link opened pairs (asked first) or listens; so does Ask KOS.
public struct PhoneScene: Scene {
  @StateObject private var phone = Phone.onThisDevice()
  @ObservedObject private var handsFree = HandsFree.shared

  public init() {}

  public var body: some Scene {
    WindowGroup {
      PhoneRoot(phone: phone)
        .onOpenURL { url in
          switch PhoneLink(url) {
          case .listen: phone.listen()
          case .pair(let link): Task { await phone.pairing.open(link) }
          case nil: break
          }
        }
        .onChange(of: handsFree.asked) { phone.listen() }
        .onAppear {
          phone.start()
          // Asked before the window was up: Ask KOS opens the app cold.
          if handsFree.asked > 0 { phone.listen() }
        }
      #if os(macOS)
        .frame(width: 390, height: 844)
      #endif
    }
    #if os(macOS)
    .windowResizability(.contentSize)
    #endif
  }
}
