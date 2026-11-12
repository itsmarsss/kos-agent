import DeviceCore
import Testing

@testable import DeviceUI

@Suite("The update notice")
struct UpdateWordsTests {
  private let build = Build(id: "0123456789ab", commit: "")

  @Test func saysWhatWaitsOnTheOwnerAndWhatIsUnderWay() throws {
    let signing = try #require(UpdateWords(UpdateNotice(state: .behind, build: build, reason: .signing, command: "cd app && scripts/signing.sh setup")))
    #expect(signing.title == "An update is ready")
    #expect(signing.detail.contains("Screen Recording and Accessibility"))
    #expect(!signing.working)
    let failed = try #require(UpdateWords(UpdateNotice(state: .behind, build: build, reason: .failed, detail: "errSecInternalComponent")))
    #expect(failed.detail.hasPrefix("errSecInternalComponent. "))
    #expect(UpdateWords(UpdateNotice(state: .behind, build: build, reason: .stuck))?.title == "Still on the old build")
    #expect(UpdateWords(UpdateNotice(state: .updating, build: build))?.working == true)
  }

  @Test func staysQuietWhenThereIsNothingForTheOwnerToDo() {
    for reason in [UpdateNotice.Reason.idle, .off, .remote, .unstamped] {
      #expect(UpdateWords(UpdateNotice(state: .behind, build: build, reason: reason)) == nil)
    }
    #expect(UpdateWords(UpdateNotice(state: .current, build: build)) == nil)
    #expect(UpdateWords(UpdateNotice(state: .unknown)) == nil)
  }

  @Test func isPutAwayOncePerBuildAndReason() {
    let signing = UpdateNotice(state: .behind, build: build, reason: .signing)
    let failed = UpdateNotice(state: .behind, build: build, reason: .failed)
    #expect(signing.key != failed.key)
    #expect(signing.key == UpdateNotice(state: .behind, build: build, reason: .signing, command: "other").key)
  }
}
