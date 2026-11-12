import PhoneCore
import SwiftUI

/// The app's root: the pairing until there is a KOS, then the chat.
public struct PhoneRoot: View {
  @ObservedObject private var phone: Phone

  public init(phone: Phone) {
    self.phone = phone
  }

  public var body: some View {
    Text("KOS")
  }
}
