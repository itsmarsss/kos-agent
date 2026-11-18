import DeviceCore
import Foundation
import Testing

@testable import DeviceKit

/// The approval card's words, apart from its views: what it titles, lists and lays out for Details.
@Suite("An ask's card")
struct AskPiecesTests {
  @Test func titlesByTheHostsWordsAndFallsBackForAnOlderHost() {
    #expect(ChatModel.Ask(id: "1", tool: "shell.run", summary: "Run: ls", title: "Run ls").heading == "Run ls")
    #expect(ChatModel.Ask(id: "1", tool: "shell.run", summary: "Run: ls").heading == "Run: ls")
    #expect(ChatModel.Ask(id: "1", tool: "shell.run").heading == "shell.run")
    // An older host's mechanics are one line; a host that sent neither lists nothing.
    #expect(ChatModel.Ask(id: "1", tool: "computer.act", mechanics: "Click, type “x”").stepLines == [[.text("Click, type “x”")]])
    #expect(ChatModel.Ask(id: "1", tool: "shell.run").stepLines.isEmpty)
  }

  @Test func saysAStepsKeysAsTheirCaps() {
    let line: StepLine = [.text("Press "), .key("⌘−"), .text(" 4 times, then "), .key("⌘Home")]
    #expect(AskWords.plain(line) == "Press ⌘− 4 times, then ⌘Home")
    let keys = AskWords.attributed(line).runs.filter { $0.backgroundColor != nil }.count
    #expect(keys == 2)
  }

  @Test func laysTheArgumentsOutAsFieldsInTheOrderWritten() {
    let node = ArgNode.parse(#"{"intent":"Zoom out","actions":[{"press":"Meta+Minus"},{"press":"Meta+Home"}],"count":2,"on":true,"none":null}"#)
    guard case .fields(let fields) = node else {
      Issue.record("not fields")
      return
    }
    #expect(fields.map(\.key) == ["intent", "actions", "count", "on", "none"])
    #expect(fields[0].value == .text("Zoom out"))
    #expect(fields[1].value == .list([.fields([.init(key: "press", value: .text("Meta+Minus"))]), .fields([.init(key: "press", value: .text("Meta+Home"))])]))
    #expect(fields[2].value == .plain("2") && fields[3].value == .plain("true") && fields[4].value == .plain("null"))
  }

  @Test func keepsEachObjectsOwnOrderWhateverItsWordsSay() {
    // A key's name appearing earlier inside a string must not move it.
    let node = ArgNode.parse(#"{"note":"see \"zeta\" and the actions","zeta":{"b":2,"a":[true,null,-1.5e2]},"actions":[]}"#)
    #expect(node == .fields([
      .init(key: "note", value: .text(#"see "zeta" and the actions"#)),
      .init(key: "zeta", value: .fields([.init(key: "b", value: .plain("2")), .init(key: "a", value: .list([.plain("true"), .plain("null"), .plain("-1.5e2")]))])),
      .init(key: "actions", value: .list([])),
    ]))
    #expect(ArgNode.parse(#"{"a":1} trailing"#) == .text(#"{"a":1} trailing"#))
  }

  @Test func keepsTextCutToFitAsTheTextItIs() {
    #expect(ArgNode.parse(#"{"command":"ls -la /ve…"#) == .text(#"{"command":"ls -la /ve…"#))
    #expect(ArgNode.pretty(#"{"a":1}"#) == "{\n  \"a\" : 1\n}")
    #expect(ArgNode.pretty("not json") == "not json")
  }

  @Test func marksWhereItActs() {
    #expect(AskWords.placeSymbol("computer.act") == "desktopcomputer")
    #expect(AskWords.placeSymbol("shell.run") == "folder")
    #expect(AskWords.placeSymbol("mcp.gmail.send_email") == "envelope")
    #expect(AskWords.placeSymbol("mcp.notion.search") == "server.rack")
    #expect(AskWords.placeSymbol("browser.act") == "globe")
  }

  @Test func saysAnOlderHostsReasonAsTheRisk() {
    #expect(AskWords.risk("clicks, types or fills on the page, in your Chrome") == "Clicks, types or fills on the page")
    #expect(AskWords.risk("risky tool") == nil)
    #expect(AskWords.risk("on shop.example") == nil)
  }

  @Test func saysHowLongAStepTookAsTheDashboardDoes() {
    #expect(durationWords(420) == "420ms")
    #expect(durationWords(2_400) == "2.4s")
    #expect(durationWords(12_300) == "12s")
    #expect(durationWords(64_000) == "1m 04s")
    #expect(durationWords(3_840_000) == "1h 04m")
  }
}
