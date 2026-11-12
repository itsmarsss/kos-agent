import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The app's root: the pairing until there is a KOS, then the chat, with a
/// link opened meanwhile asked about over it; drawn in the dashboard's theme,
/// the phone's own until KOS has said, and built again at a new text size so
/// every size in KOS's ladder follows it.
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
        ChatScreen(phone: phone).modifier(Repairing(flow: phone.pairing, problem: phone.problem))
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

/// A pairing link opened while paired: the pairing screen over the chat, from the ask to replace the pairing
/// to the pairing made, or what went wrong. Put away, nothing of it is sent.
private struct Repairing: ViewModifier {
  @ObservedObject var flow: PairingFlow
  let problem: String?

  func body(content: Content) -> some View {
    content.sheet(isPresented: Binding(get: { flow.underway || flow.error != nil }, set: { if !$0 { flow.dismiss() } })) {
      PairingScreen(flow: flow, problem: problem)
        .background(Theme.bg.ignoresSafeArea())
        .presentationDetents([.large])
    }
  }
}
