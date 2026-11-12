import Foundation
import Testing
@testable import DeviceCore

private let commit = String(repeating: "a", count: 40)

@Suite("Builds and updates")
struct BuildsTests {
  @Test func readsAStampAsKOSDoes() throws {
    let stamp = Build.read(Data(#"{"id":"0123456789ab","commit":"\#(commit)","builtAt":1761800000000}"#.utf8))
    #expect(stamp == Build(id: "0123456789ab", commit: commit, builtAt: 1_761_800_000_000))
    #expect(stamp?.short == "aaaaaaa")
    #expect(Build(id: "0123456789ab", commit: "").short == "0123456789ab")
    #expect(Build.read(Data(#"{"id":"NOTHEX","commit":""}"#.utf8)) == nil)
    #expect(Build.read(Data(#"{"id":"0123456789ab","commit":"short"}"#.utf8)) == nil)
    #expect(Build.read(Data("{".utf8)) == nil)
  }

  @Test func findsTheStampInTheAppsResources() throws {
    // Two folders: a Bundle is cached by its path, what it found there with it.
    let bare = FileManager.default.temporaryDirectory.appendingPathComponent("builds-\(UUID().uuidString).bundle")
    let stamped = FileManager.default.temporaryDirectory.appendingPathComponent("builds-\(UUID().uuidString).bundle")
    defer { [bare, stamped].forEach { try? FileManager.default.removeItem(at: $0) } }
    for folder in [bare, stamped] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    try Data(#"{"id":"0123456789ab","commit":""}"#.utf8).write(to: stamped.appendingPathComponent("build.json"))
    #expect(Build.stamped(in: try #require(Bundle(url: bare))) == nil)
    #expect(Build.stamped(in: try #require(Bundle(url: stamped))) == Build(id: "0123456789ab", commit: ""))
  }

  @Test func saysItsBuildInTheHelloAndNoneWhenItHasNone() throws {
    let state = DeviceState(consent: .device, permissions: Permissions(screen: false, input: false), displays: [])
    let app = AppInfo(version: "0.1.0", platform: "ios", os: "18.1")
    let stamped = try Outbound.hello(device: "dev_1", nonce: "n", signature: "s", app: app, build: Build(id: "0123456789ab", commit: commit, builtAt: 5), state: state)
    let body = try #require(JSONSerialization.jsonObject(with: stamped) as? [String: Any])
    let build = try #require(body["build"] as? [String: Any])
    #expect(build["id"] as? String == "0123456789ab")
    #expect(build["commit"] as? String == commit)
    #expect(build["builtAt"] as? Double == 5)
    let bare = try Outbound.hello(device: "dev_1", nonce: "n", signature: "s", app: app, state: state)
    #expect((try #require(JSONSerialization.jsonObject(with: bare) as? [String: Any]))["build"] == nil)
  }

  @Test func readsKOSsWordOnTheBuild() throws {
    let raw = #"{"t":"update","state":"behind","build":{"id":"0123456789ab","commit":""},"reason":"signing","command":"cd app && scripts/signing.sh setup"}"#
    let notice = UpdateNotice(state: .behind, build: Build(id: "0123456789ab", commit: ""), reason: .signing, command: "cd app && scripts/signing.sh setup")
    #expect(try Inbound.decode(Data(raw.utf8)) == .update(notice))
    #expect(notice.key == "0123456789ab:behind:signing")
    // A reason or a Chrome's action this app does not know is passed over; a state it does not know is no notice.
    let other = #"{"t":"update","state":"behind","build":{"id":"0123456789ab","commit":""},"reason":"someday","action":"reload"}"#
    #expect(try Inbound.decode(Data(other.utf8)) == .update(UpdateNotice(state: .behind, build: Build(id: "0123456789ab", commit: ""))))
    #expect(throws: DeviceError.self) { try Inbound.decode(Data(#"{"t":"update","state":"sideways"}"#.utf8)) }
    let badBuild = #"{"t":"update","state":"current","build":{"id":"zz","commit":""}}"#
    #expect(try Inbound.decode(Data(badBuild.utf8)) == .update(UpdateNotice(state: .current)))
  }
}
