import Testing

@testable import DeviceUI

/// What of the owner's hand takes the Mac over from KOS: a click or a key always; a scroll or a nudge only when they chose any move.
@Suite("Taking over")
struct TakeoverTests {
  @Test func byDefaultAClickOrAKeyOrARealMoveTakesOver() {
    #expect(Takeover.deliberate.travel == 40)
    #expect(!Takeover.deliberate.scrollTakesOver)
    #expect(Takeover.clicksAndKeys.travel == nil)
    #expect(!Takeover.clicksAndKeys.scrollTakesOver)
    #expect(Takeover.anyMove.travel == 6)
    #expect(Takeover.anyMove.scrollTakesOver)
  }
}
