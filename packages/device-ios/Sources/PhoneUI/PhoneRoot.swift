import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The app's root: the pairing until there is a KOS, then the chat; drawn
/// in the dashboard's theme, the phone's own until KOS has said, and built
/// again at a new text size so every size in KOS's ladder follows it.
public struct PhoneRoot: View {
  @ObservedObject private var phone: Phone
  @Environment(\.scenePhase) private var phase
  @Environment(\.dynamicTypeSize) private var textSize

  public init(phone: Phone) {
    self.phone = phone
  }

  public var body: some View {
    Group {
      if phone.paired == nil {
        PairingScreen(flow: phone.pairing, problem: phone.problem)
      } else {
        ChatScreen(phone: phone)
      }
    }
    .id(textSize)
    .background(Theme.bg.ignoresSafeArea())
    .foregroundStyle(Theme.text)
    .tint(Theme.accent)
    .preferredColorScheme(phone.mode.colorScheme)
    .onChange(of: phase) { _, now in
      switch now {
      case .active: phone.foreground()
      case .background: phone.background()
      default: break
      }
    }
  }
}
