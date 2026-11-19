import DeviceCore
import DeviceKit
import Foundation
import SwiftUI
import Testing

@testable import PhoneCore
@testable import PhoneUI

/// Notifications as the iPhone answers a test: a build with push or without, and the owner's answer.
@MainActor
private final class ShownNotifier: Notifier {
  let environment: PushEnvironment?
  let allowed: PushPermission

  init(_ environment: PushEnvironment?, _ allowed: PushPermission) {
    self.environment = environment
    self.allowed = allowed
  }

  func permission() async -> PushPermission { allowed }
  func requestPermission() async -> PushPermission { allowed }
  func register() {}
  func withdraw(_ identifiers: [String]) {}
  func withdrawAll() {}
  func couldNotDecide(ask: String) {}
}

/// Settings' notifications card in each of its states: a build with no push, not yet asked, refused, and on.
extension RenderTests {
  private func push(_ environment: PushEnvironment?, _ allowed: PushPermission, token: Bool = false) async -> PushModel {
    let model = PushModel(notifier: ShownNotifier(environment, allowed))
    await model.refresh()
    if token { model.registered(Data([0xab, 0xcd])) }
    return model
  }

  @Test func theNotificationsCard() async throws {
    let cards = [
      await push(nil, .denied),
      await push(.sandbox, .undecided),
      await push(.sandbox, .denied),
      await push(.sandbox, .allowed, token: true),
    ]
    #expect(cards.map(\.on) == [false, false, false, true])
    try render("notifications", only: ["390"]) {
      Tabbed(tab: .more) {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, card in NotificationsCard(push: card) }
          }
          .padding(16)
        }
      }
    }
  }
}
