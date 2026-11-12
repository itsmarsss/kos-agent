import Foundation
import Testing

@testable import DeviceKit

/// The box's / and @ menus, as the side panel's: commands by the start of their names, and what KOS's index names.
@MainActor
@Suite("Chat menus")
struct ChatMenusTests {
  @Test func knowsACommandByItsName() {
    #expect(ChatMenus.isCommand("/new"))
    #expect(ChatMenus.isCommand("  /switch 2"))
    #expect(ChatMenus.isCommand("/Stop"))
    #expect(!ChatMenus.isCommand("/etc/hosts is broken"))
    #expect(!ChatMenus.isCommand("/"))
    #expect(!ChatMenus.isCommand("new"))
  }

  @Test func readsTheTokenAtTheEndOfTheBox() {
    #expect(ChatMenus.token(in: "/") == .init(kind: .command, q: "", start: 0, raw: "/"))
    #expect(ChatMenus.token(in: "/sw")?.q == "sw")
    #expect(ChatMenus.token(in: "/switch 2") == nil)
    #expect(ChatMenus.token(in: "ask @ali") == .init(kind: .mention, q: "ali", start: 4, raw: "@ali"))
    #expect(ChatMenus.token(in: "@") == .init(kind: .mention, q: "", start: 0, raw: "@"))
    #expect(ChatMenus.token(in: "mail me@home") == nil)
    #expect(ChatMenus.token(in: "@ali and") == nil)
  }

  @Test func offersTheCommandsHereAndWritesWhatIsNamed() {
    #expect(ChatMenus.commands("s").map(\.insert) == ["/switch ", "/stop ", "/status "])
    #expect(ChatMenus.commands("").count == 8)
    // The dashboard's own are not offered here.
    #expect(ChatMenus.commands("export").isEmpty)
    #expect(ChatMenus.commands("new").first?.label == "/new [title]")
    #expect(ChatMenus.option(.init(kind: "file", id: "notes/plan.md", label: "plan.md")).insert == "@file:notes/plan.md ")
    #expect(ChatMenus.option(.init(kind: "chat", id: "Trip to Rome", label: "Trip to Rome")).insert == "@chat:[Trip to Rome] ")
    #expect(ChatMenus.option(.init(kind: "channel", id: "general", label: "general")).insert == "#general ")
    #expect(ChatMenus.option(.init(kind: "file", id: "a", label: "a")).hint == "file")
  }

  @Test func theMenuFollowsTheBoxAndAsksKOSWhatAnAtNames() async throws {
    let model = ChatModel()
    var asked: [String] = []
    model.askMentions = { asked.append($0) }
    model.draft = "/st"
    #expect(model.menu?.options.map(\.insert) == ["/stop ", "/status "])
    model.take(try #require(model.menu?.options.first))
    #expect(model.draft == "/stop ")
    #expect(model.menu == nil)
    model.draft = "/"
    model.closeMenu()
    #expect(model.menu == nil)
    model.draft = "/n"
    #expect(model.menu != nil)
    // An @ asks KOS once typing pauses, and its answer opens the menu for that start alone.
    model.draft = "send it to @a"
    model.draft = "send it to @al"
    try await Task.sleep(for: .milliseconds(300))
    #expect(asked == ["al"])
    model.mentions([.init(kind: "contact", id: "alice", label: "Alice")], for: "al")
    #expect(model.menu?.options.map(\.insert) == ["@contact:alice "])
    model.take(try #require(model.menu?.options.first))
    #expect(model.draft == "send it to @contact:alice ")
    model.draft = "send it to @b"
    #expect(model.menu == nil)
  }
}
