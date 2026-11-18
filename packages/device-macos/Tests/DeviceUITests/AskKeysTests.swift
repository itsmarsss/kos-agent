import AppKit
import SwiftUI
import Testing

@testable import DeviceUI

/// The approval card's keys: a yes only from a card the owner reached with Tab, a no from the card focused at all.
@Suite("The approval card's keys")
struct AskKeysTests {
  @Test func returnApprovesOnlyACardReachedByTab() {
    #expect(AskKeys.decision(.return, command: false, focused: true, byTab: true, canApprove: true) == true)
    // Focused by a click, or by the window's own first focus: Return is no yes.
    #expect(AskKeys.decision(.return, command: false, focused: true, byTab: false, canApprove: true) == nil)
    #expect(AskKeys.decision(.return, command: false, focused: false, byTab: true, canApprove: true) == nil)
    // Too long to have been sent whole: there is nothing here to approve.
    #expect(AskKeys.decision(.return, command: false, focused: true, byTab: true, canApprove: false) == nil)
  }

  @Test func escapeAndCommandDeleteDenyAFocusedCard() {
    #expect(AskKeys.decision(.escape, command: false, focused: true, byTab: false, canApprove: true) == false)
    #expect(AskKeys.decision(.delete, command: true, focused: true, byTab: false, canApprove: true) == false)
    #expect(AskKeys.decision(.delete, command: false, focused: true, byTab: false, canApprove: true) == nil)
    #expect(AskKeys.decision(.escape, command: false, focused: false, byTab: false, canApprove: true) == nil)
  }

  @Test func onlyATabKeyPressIsFocusByTab() throws {
    let tab = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\t", charactersIgnoringModifiers: "\t", isARepeat: false, keyCode: 48))
    let other = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0))
    let click = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    #expect(AskKeys.cameByTab(tab))
    #expect(!AskKeys.cameByTab(other))
    #expect(!AskKeys.cameByTab(click))
    #expect(!AskKeys.cameByTab(nil))
  }
}
