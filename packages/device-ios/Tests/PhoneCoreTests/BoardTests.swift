import DeviceCore
import DeviceKit
import Foundation
import Testing

@testable import PhoneCore

/// KOS's side of the dashboard's routes, played over the rig's line: each request the phone made, and its answer.
@MainActor
final class Routed {
  let rig: Rig
  private var answered: Set<Int> = []

  init(rig: Rig) {
    self.rig = rig
  }

  /// The requests sent, in order.
  var asked: [[String: Any]] { rig.line.sent.filter { $0["name"] as? String == DashboardRequest.event }.compactMap { $0["data"] as? [String: Any] } }

  /// Waits for the phone to have asked `count` requests in all.
  func await(_ count: Int) async {
    for _ in 0..<200 where asked.count < count { await Task.yield() }
  }

  /// The latest request of this path, and of this query when one is named.
  func request(_ path: String, query: [String: String]? = nil) -> [String: Any]? {
    asked.last { $0["path"] as? String == path && (query == nil || ($0["query"] as? [String: String] ?? [:]) == query) }
  }

  /// The latest request of this path not answered yet, and of this query when one is named.
  private func open(_ path: String, query: [String: String]?) throws -> Int {
    let calls = asked.filter { $0["path"] as? String == path && (query == nil || ($0["query"] as? [String: String] ?? [:]) == query) }.compactMap { $0["call"] as? Int }
    let call = try #require(calls.last { !answered.contains($0) }, "nothing open asked of \(path)")
    answered.insert(call)
    return call
  }

  /// Answers it with the route's JSON.
  func answer(_ path: String, query: [String: String]? = nil, status: Int = 200, _ body: String) async throws {
    let call = try open(path, query: query)
    _ = try await rig.line.call(DashboardReply.method, #"{"call":\#(call),"status":\#(status),"body":\#(body)}"#)
  }

  /// Answers it with bytes.
  func bytes(_ path: String, type: String, _ data: Data) async throws {
    let call = try open(path, query: nil)
    _ = try await rig.line.call(DashboardReply.method, #"{"call":\#(call),"status":200,"type":"\#(type)","data":"\#(data.base64EncodedString())"}"#)
  }

  /// Refuses it in words, as KOS refuses a request off its list.
  func refuse(_ path: String, _ words: String) async throws {
    let call = try open(path, query: nil)
    _ = try await rig.line.call(DashboardReply.method, #"{"call":\#(call),"error":"\#(words)"}"#)
  }
}

private let pending = #"{"id":41,"tool":"files.write","args":"{\"path\":\"notes/list.md\"}","reason":null,"summary":"Write notes/list.md","conversationId":"c_2","asker":"Inbox sweep","requestedAt":1761800000000,"expiresAt":1761803600000,"rule":{"tool":"files.write","scope":"dir:notes","project":null}}"#
private let decided = #"[{"id":40,"tool":"shell.run","status":"approved","summary":"Run git push","asker":"KOS","decidedAt":1761799000000,"requestedAt":1761798000000,"conversationId":null,"reason":null}]"#

@MainActor
@Suite("The Inbox on the phone")
struct InboxTests {
  @Test func readsWhatWaitsAndWhatWasDecidedAsTheDashboardDoes() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let inbox = rig.phone.board.inbox
    let read = Task { await inbox.refresh() }
    await kos.await(3)
    #expect(kos.request("/api/inbox")?["method"] as? String == "GET")
    #expect(kos.request("/api/approvals/history")?["query"] as? [String: String] == ["limit": "25"])
    try await kos.answer("/api/inbox", #"{"approvals":[\#(pending),{"id":"bad"}],"failures":[{"key":"cron:3","label":"Nightly backup","streak":2,"error":"disk full","since":5,"lastAt":6}],"decisions":[],"suggestions":[]}"#)
    try await kos.answer("/api/approvals/history", decided)
    try await kos.answer("/api/approvals/history/counts", #"{"approved":12,"denied":3,"expired":1}"#)
    await read.value
    #expect(inbox.waiting.value?.approvals.map(\.id) == [41])
    #expect(inbox.waiting.value?.failures.first?.label == "Nightly backup")
    #expect(inbox.decided.map(\.id) == [40] && inbox.counts?.approved == 12 && !inbox.more)
    #expect(inbox.waiting.value?.approvals.first?.always == "Always in notes")
  }

  @Test func holdsTheDecidedToAnOutcomeAndWordsAndReadsOnAfterTheLastRow() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let inbox = rig.phone.board.inbox
    inbox.outcome = .denied
    inbox.words = "  push "
    let first = Task { await inbox.refresh() }
    await kos.await(3)
    #expect(kos.request("/api/approvals/history")?["query"] as? [String: String] == ["limit": "25", "status": "denied", "q": "push"])
    let page = "[" + (0..<25).map { #"{"id":\#(100 - $0),"tool":"t","status":"denied","summary":"s","decidedAt":\#(9000 - $0),"requestedAt":1}"# }.joined(separator: ",") + "]"
    try await kos.answer("/api/approvals/history", page)
    try await kos.answer("/api/approvals/history/counts", #"{"approved":0,"denied":30,"expired":0}"#)
    try await kos.answer("/api/inbox", #"{"approvals":[],"failures":[]}"#)
    await first.value
    #expect(inbox.more && inbox.decided.count == 25)
    let next = Task { await inbox.readMore() }
    await kos.await(4)
    #expect((kos.request("/api/approvals/history")?["query"] as? [String: String])?["before"] == "8976,76")
    try await kos.answer("/api/approvals/history", decided)
    await next.value
    #expect(inbox.decided.count == 26 && !inbox.more)
  }

  @Test func decidesAsTheDeviceFeelsItAndTheOtherCardsGo() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let inbox = rig.phone.board.inbox
    rig.phone.chat.ask(.init(id: "41", tool: "files.write", chat: "phone:owner"))
    let read = Task { await inbox.waiting.refresh() }
    await kos.await(1)
    try await kos.answer("/api/inbox", #"{"approvals":[\#(pending)],"failures":[]}"#)
    await read.value
    let ask = try #require(inbox.waiting.value?.approvals.first)
    let decide = Task { await inbox.decide(ask, approved: true, remember: true) }
    await kos.await(2)
    let sent = try #require(kos.request("/api/approve"))
    #expect(sent["method"] as? String == "POST")
    #expect((sent["body"] as? [String: Any])?["id"] as? Int == 41 && (sent["body"] as? [String: Any])?["remember"] as? Bool == true)
    #expect(inbox.deciding == [41])
    try await kos.answer("/api/approve", #"{"id":41,"approved":true}"#)
    await kos.await(4)
    try await kos.answer("/api/approvals/history", "[]")
    try await kos.answer("/api/approvals/history/counts", #"{"approved":1,"denied":0,"expired":0}"#)
    await decide.value
    #expect(rig.haptics.felt == ["done"])
    #expect(inbox.waiting.value?.approvals.isEmpty == true && inbox.deciding.isEmpty)
    #expect(rig.phone.chat.asks.isEmpty)
  }

  @Test func aDenialThatDidNotGoIsSaidAndTheRowStays() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let inbox = rig.phone.board.inbox
    let read = Task { await inbox.waiting.refresh() }
    await kos.await(1)
    try await kos.answer("/api/inbox", #"{"approvals":[\#(pending)],"failures":[]}"#)
    await read.value
    let decide = Task { await inbox.decide(inbox.waiting.value!.approvals[0], approved: false) }
    await kos.await(2)
    #expect((kos.request("/api/deny")?["body"] as? [String: Any])?.keys.sorted() == ["id"])
    try await kos.refuse("/api/deny", "That is not one a phone does.")
    await decide.value
    #expect(rig.haptics.felt == ["tap", "attention"])
    #expect(inbox.waiting.value?.approvals.count == 1)
    #expect(rig.phone.board.toasts.shown?.words == "Couldn't deny files.write. That is not one a phone does.")
  }

  @Test func decidedInTheChatTheRowGoesHereToo() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let inbox = rig.phone.board.inbox
    let read = Task { await inbox.waiting.refresh() }
    await kos.await(1)
    try await kos.answer("/api/inbox", #"{"approvals":[\#(pending)],"failures":[]}"#)
    await read.value
    _ = try await rig.line.call("chat.settled", #"{"approval":"41","outcome":"approved"}"#, id: 9)
    #expect(inbox.waiting.value?.approvals.isEmpty == true)
  }
}

@MainActor
@Suite("The dashboard's pages on the phone")
struct BoardTests {
  @Test func offTheLineAPageSaysSoAtOnce() async throws {
    let rig = Rig(paired: Rig.pairing)
    rig.phone.start()
    let page = rig.phone.board.projects.list
    await page.refresh()
    #expect(page.error == "Not connected to KOS." && page.value == nil)
    #expect(rig.line.sent.isEmpty)
  }

  @Test func pastFourAtOnceTheRestWaitTheirTurnHere() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let pages = (0..<5).map { rig.phone.board.files.folder("f\($0)") }
    let reads = pages.map { page in Task { await page.refresh() } }
    await kos.await(5)
    #expect(kos.asked.count == Dashboard.atOnce)
    try await kos.answer("/api/files", query: ["path": "f0"], #"{"path":"f0","entries":[]}"#)
    await kos.await(5)
    #expect(kos.asked.count == 5)
    for path in ["f1", "f2", "f3", "f4"] { try await kos.answer("/api/files", query: ["path": path], #"{"path":"\#(path)","entries":[]}"#) }
    for read in reads { await read.value }
    #expect(pages.allSatisfy { $0.value?.entries == [] })
  }

  @Test func whatWasReadStaysWhileItIsReadAgainAndAFailureSaysWhy() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let projects = rig.phone.board.projects
    let first = Task { await projects.list.refresh() }
    await kos.await(1)
    try await kos.answer("/api/projects", #"[{"slug":"garden","name":"Garden","type":"tracker","status":"active","lastTouchedAt":5,"tableCount":2},{"slug":"fit","name":"Fitness","type":"plan","status":"dormant","lastTouchedAt":9}]"#)
    await first.value
    #expect(projects.list.value?.map(\.slug) == ["fit", "garden"])
    let again = Task { await projects.list.refresh() }
    await kos.await(2)
    #expect(projects.list.loading && projects.list.value?.count == 2)
    try await kos.answer("/api/projects", status: 500, #"{"error":"database is locked"}"#)
    await again.value
    #expect(projects.list.value?.count == 2 && projects.list.error == "KOS couldn't do that: database is locked")
  }

  @Test func aProjectsPageHasItsChatsArtifactsTablesAndSchedules() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let page = rig.phone.board.projects.page("garden")
    #expect(rig.phone.board.projects.page("garden") === page)
    let read = Task { await page.refresh() }
    await kos.await(1)
    try await kos.answer(
      "/api/projects/garden/detail",
      #"{"project":{"slug":"garden","name":"Garden","status":"active","lastTouchedAt":5},"tables":[{"name":"beds","rows":4,"columns":3}],"pages":[{"id":"plan","title":"Plan","kind":"html","artifactKind":"doc","projectSlug":"garden","updatedAt":5}],"crons":[{"id":3,"name":"Water","schedule":"0 7 * * *","type":"actions","enabled":true}],"agents":[{"id":"c_9","title":"Bed layout","updatedAt":5,"activity":"idle"}],"folder":"projects/garden","sites":[]}"#)
    await read.value
    let detail = try #require(page.value)
    #expect(detail.tables.first?.rows == 4 && detail.pages.first?.artifactKind == "doc" && detail.crons.first?.name == "Water" && detail.agents.first?.title == "Bed layout")
  }

  @Test func theGalleryOpensHTMLOnlyHeldToAKindAndWordsAndRestoresFromTheTrash() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let gallery = rig.phone.board.gallery
    let read = Task { await gallery.refresh() }
    await kos.await(2)
    #expect(kos.asked.compactMap { $0["query"] as? [String: String] } == [["trashed": "1"]])
    let all = #"[{"id":"plan","title":"Garden plan","kind":"html","artifactKind":"doc","description":"Beds and dates","updatedAt":5},{"id":"costs","title":"Costs","kind":"html","artifactKind":"sheet","updatedAt":9},{"id":"old","title":"Old","kind":"spec","artifactKind":"page","updatedAt":12}]"#
    try await kos.answer("/api/artifacts", query: [:], all)
    try await kos.answer("/api/artifacts", query: ["trashed": "1"], #"[{"id":"gone","title":"Gone","kind":"html","artifactKind":"deck","updatedAt":1,"trashedAt":7}]"#)
    await read.value
    #expect(gallery.shown.map(\.id) == ["costs", "plan"])
    gallery.kind = "doc"
    #expect(gallery.shown.map(\.id) == ["plan"])
    gallery.kind = nil
    gallery.words = "beds GARDEN"
    #expect(gallery.shown.map(\.id) == ["plan"])
    let restore = Task { await gallery.restore(gallery.trash.value![0]) }
    await kos.await(3)
    #expect(kos.request("/api/artifacts/gone/restore")?["method"] as? String == "POST")
    try await kos.answer("/api/artifacts/gone/restore", #"{"id":"gone"}"#)
    await kos.await(5)
    try await kos.answer("/api/artifacts", query: [:], all)
    try await kos.answer("/api/artifacts", query: ["trashed": "1"], "[]")
    await restore.value
    #expect(rig.phone.board.toasts.shown?.words == "Restored Gone" && rig.haptics.felt == ["done"])
  }

  @Test func runsNowPausesAndResumesASchedule() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let runs = rig.phone.board.runs
    let read = Task { await runs.refresh() }
    await kos.await(2)
    #expect(kos.request("/api/runs")?["query"] as? [String: String] == ["limit": "50"])
    try await kos.answer("/api/crons", #"[{"id":3,"name":"Nightly backup","schedule":"0 3 * * *","type":"actions","enabled":true,"nextRunAt":9}]"#)
    try await kos.answer("/api/runs", #"[{"id":7,"kind":"cron","status":"error","error":"disk full","startedAt":5,"ref":"3"}]"#)
    await read.value
    #expect(runs.runs.value?.first?.status == "error")
    let now = Task { await runs.runNow(id: 3, name: "Nightly backup") }
    await kos.await(3)
    #expect((kos.request("/api/crons/run")?["body"] as? [String: Any])?["id"] as? Int == 3)
    try await kos.answer("/api/crons/run", #"{"ok":true}"#)
    await kos.await(5)
    try await kos.answer("/api/crons", #"[{"id":3,"name":"Nightly backup","schedule":"0 3 * * *","type":"actions","enabled":true,"running":true}]"#)
    try await kos.answer("/api/runs", "[]")
    await now.value
    #expect(rig.phone.board.toasts.shown?.words == "Running Nightly backup" && runs.crons.value?.first?.running == true)
    let pause = Task { await runs.setEnabled(id: 3, name: "Nightly backup", false) }
    await kos.await(6)
    #expect((kos.request("/api/crons/enable")?["body"] as? [String: Any])?["enabled"] as? Bool == false)
    try await kos.answer("/api/crons/enable", #"{"id":3,"enabled":false}"#)
    #expect(runs.busy == [3])
    await kos.await(8)
    try await kos.answer("/api/crons", #"[{"id":3,"name":"Nightly backup","schedule":"0 3 * * *","type":"actions","enabled":false}]"#)
    try await kos.answer("/api/runs", "[]")
    await pause.value
    #expect(runs.crons.value?.first?.enabled == false && rig.phone.board.toasts.shown?.words == "Nightly backup is paused")
    #expect(rig.haptics.felt == ["tap", "done", "tap", "done"])
  }

  @Test func filesOpenAsWhatTheyAre() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let files = rig.phone.board.files
    #expect(FilesModel.way("a/B.JPG") == .picture && FilesModel.way("doc.pdf") == .pdf && FilesModel.way("notes.md") == .text)
    let folder = files.folder("projects/garden")
    let browse = Task { await folder.refresh() }
    await kos.await(1)
    #expect(kos.request("/api/files")?["query"] as? [String: String] == ["path": "projects/garden"])
    try await kos.answer("/api/files", #"{"path":"projects/garden","entries":[{"name":"z.md","path":"projects/garden/z.md","kind":"file","size":3,"modifiedAt":1},{"name":"beds","path":"projects/garden/beds","kind":"dir","size":0,"modifiedAt":1},{"name":"A.md","path":"projects/garden/A.md","kind":"file","size":3,"modifiedAt":1}]}"#)
    await browse.value
    #expect(folder.value?.entries.map(\.name) == ["beds", "A.md", "z.md"])

    let picture = files.file("projects/garden/bed.png")
    let open = Task { await picture.refresh() }
    await kos.await(2)
    try await kos.bytes("/api/file/raw", type: "image/png", Data([0x89, 0x50]))
    await open.value
    #expect(picture.value == .picture(Data([0x89, 0x50]), type: "image/png"))

    let pdf = files.file("projects/garden/plan.pdf")
    let read = Task { await pdf.refresh() }
    await kos.await(3)
    try await kos.bytes("/api/file/view", type: "application/pdf", Data("%PDF".utf8))
    await read.value
    #expect(pdf.value == .pdf(Data("%PDF".utf8)))

    let binary = files.file("projects/garden/db.sqlite")
    let look = Task { await binary.refresh() }
    await kos.await(4)
    try await kos.answer("/api/file", #"{"path":"projects/garden/db.sqlite","size":9,"modifiedAt":1,"omitted":"binary","language":""}"#)
    await look.value
    #expect(binary.value == .none("This file isn't something a phone can show."))
  }

  @Test func memoryIsSearchedByKeyWordsAndTagsPinnedFirst() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let memory = rig.phone.board.memory
    let read = Task { await memory.claims.refresh() }
    await kos.await(1)
    #expect(kos.request("/api/memory")?["query"] as? [String: String] == ["limit": "1000"])
    let claim = { (id: Int, key: String, value: String, tags: String, pinned: Bool, at: Int) in
      #"{"id":\#(id),"key":"\#(key)","value":"\#(value)","kind":"fact","scope":"global","source":"chat","tags":[\#(tags)],"pinned":\#(pinned),"trust":"owner","updatedAt":\#(at)}"#
    }
    try await kos.answer("/api/memory", #"{"facts":[\#(claim(1, "home.city", "Toronto", #""home""#, false, 9)),\#(claim(2, "diet", "No peanuts", #""food","home""#, true, 1)),\#(claim(3, "car", "Blue Civic", "", false, 5))],"tags":[]}"#)
    await read.value
    #expect(memory.shown.map(\.id) == [2, 1, 3])
    #expect(memory.tags == ["home", "food"])
    memory.tag = "home"
    #expect(memory.shown.map(\.id) == [2, 1])
    memory.words = "toronto"
    #expect(memory.shown.map(\.id) == [1])
    let trace = memory.trace("home.city")
    let traced = Task { await trace.refresh() }
    await kos.await(2)
    #expect(kos.request("/api/memory/trace")?["query"] as? [String: String] == ["key": "home.city"])
    try await kos.answer("/api/memory/trace", #"{"key":"home.city","claim":{},"before":[\#(claim(0, "home.city", "Ottawa", "", false, 2))],"evidence":[{"id":5,"ts":3,"role":"owner","text":"I moved to Toronto"}]}"#)
    await traced.value
    #expect(trace.value?.before.first?.value == "Ottawa" && trace.value?.evidence.first?.text == "I moved to Toronto")
  }

  @Test func aBlobsChatIsReadByItsId() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let blobs = rig.phone.board.blobs
    let list = Task { await blobs.list.refresh() }
    await kos.await(1)
    try await kos.answer("/api/agents", #"{"agents":[{"name":"scout","description":"Watches prices","folder":"blobs/scout","conversationId":"agent:scout","thread":{"id":"agent:scout","activity":"idle","unread":false,"updatedAt":5,"lastSaid":"Nothing new."},"job":{"id":8,"schedule":"0 9 * * *","enabled":true,"lastRunAt":null,"nextRunAt":9}}],"invalid":[]}"#)
    await list.value
    #expect(blobs.list.value?.first?.job?.id == 8)
    let chat = blobs.chat("agent:scout")
    let read = Task { await chat.refresh() }
    await kos.await(2)
    #expect(kos.request("/api/conversations/agent:scout/messages") != nil)
    try await kos.answer("/api/conversations/agent:scout/messages", #"{"id":"agent:scout","messages":[{"role":"you","text":"Any drops?"},{"role":"kos","text":"Nothing new."}],"events":[],"pending":[]}"#)
    await read.value
    #expect(chat.value?.messages.map(\.role) == ["you", "kos"])
  }

  @Test func theLineDroppingFailsWhatWasAskedAndUnpairingForgetsItAll() async throws {
    let rig = try await Rig.online()
    let kos = Routed(rig: rig)
    let page = rig.phone.board.overview.home
    let read = Task { await page.refresh() }
    await kos.await(1)
    rig.line.onStatus?(.offline("gone"))
    await read.value
    #expect(page.error == "The line to KOS closed.")
    rig.line.onStatus?(.connected(name: "iPhone"))
    let again = Task { await page.refresh() }
    await kos.await(2)
    try await kos.answer("/api/home", #"{"approvals":[],"runs":[{"id":1,"kind":"cron","status":"ok","startedAt":1}],"health":{"ok":true,"failing":[],"recent":{"total":4,"errors":1,"rate":0.25}},"projects":[],"chats":[],"upcoming":[{"id":3,"name":"Water","at":9}],"spend":{"models":[{"provider":"a","model":"m","inputTokens":1,"outputTokens":1,"calls":3,"cost":0.5},{"provider":"a","model":"n","inputTokens":1,"outputTokens":1,"calls":1}],"byDay":[]},"memory":{"claims":12,"unread":0,"extraction":true,"decisions":0,"jobs":[]}}"#)
    await again.value
    #expect(page.value?.health.recent.errors == 1 && OverviewModel.cost(page.value?.spend) == 0.5)
    rig.phone.unpair()
    #expect(page.value == nil && rig.phone.board.inbox.decided.isEmpty)
  }
}
