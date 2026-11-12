import AppKit
import DeviceCore
import DeviceKit
import Foundation
import SwiftUI
import Testing

@testable import PhoneCore
@testable import PhoneUI

/// The dashboard's pages on the phone, each drawn as the app draws it, over the tab bar, filled as KOS would answer
/// its route: at both sizes in both themes, and at a large text size.
extension RenderTests {
  /// Epoch milliseconds, some minutes before now.
  static func ago(_ minutes: Double) -> Double { (Date().timeIntervalSince1970 - minutes * 60) * 1000 }

  static func read<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  /// Each size and theme, then the larger text at 390 in both themes.
  func renderPage<V: View>(_ name: String, _ view: @escaping () -> V) throws {
    try render(name, view)
    KOSType.scale = 1.35
    defer { KOSType.scale = nil }
    try render("\(name)-large-text", only: ["390"], view)
  }

  static func inbox() throws -> Routes.Inbox {
    try read(
      Routes.Inbox.self,
      #"""
      {"approvals":[
        {"id":41,"tool":"email.send","args":"{\"to\":\"sam@example.com\"}","reason":null,"summary":"Email Sam: Saturday at 4 works","why":"Reply to Sam that Saturday at 4 works.","conversationId":"c3","asker":"Inbox sweep","requestedAt":\#(ago(3)),"expiresAt":\#(ago(-52)),"rule":{"tool":"email.send","scope":"host:example.com","project":null}},
        {"id":42,"tool":"shell.run","args":"{\"command\":\"git push\"}","reason":null,"summary":"Run git push in garden","why":"Push the garden plan you approved this morning.","conversationId":"c1","asker":"Garden","requestedAt":\#(ago(20)),"expiresAt":\#(ago(-9)),"rule":null}
      ],
      "failures":[{"key":"cron:3","label":"Nightly backup","streak":3,"error":"rsync: write failed: No space left on device","since":\#(ago(2880)),"lastAt":\#(ago(400))}]}
      """#)
  }

  static func decided() throws -> [Routes.Decided] {
    try read(
      Routes.List<Routes.Decided>.self,
      #"""
      [{"id":40,"tool":"files.write","status":"approved","summary":"Write notes/groceries.md","asker":"KOS","decidedAt":\#(ago(45)),"requestedAt":\#(ago(46))},
       {"id":39,"tool":"http.fetch","status":"denied","summary":"Fetch shop.example.com/checkout","asker":"Scout","decidedAt":\#(ago(190)),"requestedAt":\#(ago(191))},
       {"id":37,"tool":"sql","status":"expired","summary":"Update 14 rows in garden_beds","asker":"Garden","decidedAt":\#(ago(1500)),"requestedAt":\#(ago(2900))},
       {"id":36,"tool":"shell.run","status":"approved","summary":"Run npm test in fix-login","asker":"Fix login","decidedAt":\#(ago(3000)),"requestedAt":\#(ago(3001))}]
      """#).items
  }

  static let projects = #"""
    [{"slug":"garden","name":"Garden","type":"tracker","status":"active","description":"Four raised beds, planted in two rounds.","colour":"#3ecf8e","lastTouchedAt":\#(ago(12)),"tableCount":3},
     {"slug":"budget_2026","name":"Household budget","type":"budget","status":"active","colour":null,"lastTouchedAt":\#(ago(300)),"tableCount":2},
     {"slug":"fitness","name":"Fitness","type":"plan","status":"dormant","colour":"#a57cff","lastTouchedAt":\#(ago(9000)),"tableCount":1},
     {"slug":"move","name":"Moving house","type":"plan","status":"done","colour":"#e6b84d","lastTouchedAt":\#(ago(40000)),"tableCount":0}]
    """#

  static let artifacts = #"""
    [{"id":"garden-doc","title":"Beds for the new season","kind":"html","artifactKind":"doc","description":"Where each bed goes, and what is planted when.","projectSlug":"garden","updatedAt":\#(ago(25))},
     {"id":"garden-sheet","title":"Garden costs","kind":"html","artifactKind":"sheet","description":"Timber, soil and seed, with totals.","projectSlug":"garden","updatedAt":\#(ago(130))},
     {"id":"price-watch","title":"Price watch","kind":"html","artifactKind":"page","blob":"scout","updatedAt":\#(ago(2000))},
     {"id":"garden-deck","title":"Garden plan","kind":"html","artifactKind":"deck","projectSlug":"garden","updatedAt":\#(ago(4000))},
     {"id":"budget-march","title":"March spending","kind":"html","artifactKind":"sheet","projectSlug":"budget_2026","updatedAt":\#(ago(20000))}]
    """#

  static let crons = #"""
    [{"id":3,"name":"Nightly backup","schedule":"0 3 * * *","type":"actions","enabled":true,"lastRunAt":\#(ago(400)),"nextRunAt":\#(ago(-500))},
     {"id":5,"name":"Water the beds","schedule":"0 7 * * *","type":"actions","enabled":true,"projectSlug":"garden","running":true,"lastRunAt":\#(ago(1))},
     {"id":8,"name":"scout","schedule":"0 9 * * 1-5","type":"self_prompt","enabled":false,"lastRunAt":\#(ago(3000))}]
    """#

  static let runs = #"""
    [{"id":90,"kind":"cron","status":"running","error":null,"startedAt":\#(ago(1)),"ref":"5"},
     {"id":89,"kind":"cron","status":"error","error":"rsync: write failed: No space left on device","startedAt":\#(ago(400)),"ref":"3","durationMs":4100},
     {"id":88,"kind":"cron","status":"ok","error":null,"startedAt":\#(ago(1440)),"ref":"5","durationMs":800},
     {"id":87,"kind":"cron","status":"ok","error":null,"startedAt":\#(ago(1500)),"ref":"8","durationMs":95000}]
    """#

  /// A phone with the Inbox read.
  func inboxPhone() throws -> Phone {
    let phone = Phone.preview()
    online(phone)
    phone.board.inbox.waiting.value = try Self.inbox()
    phone.board.inbox.decided = try Self.decided()
    phone.board.inbox.counts = .init(approved: 128, denied: 14, expired: 6)
    return phone
  }

  @Test func theInbox() throws {
    let phone = try inboxPhone()
    try renderPage("inbox") { Tabbed(tab: .inbox, badges: [.inbox: 2]) { InboxScreen(inbox: phone.board.inbox) } }
    let ask = try #require(phone.board.inbox.waiting.value?.approvals.first)
    try render("inbox-ask", only: ["390"]) {
      SheetOver(height: 0.62) { Tabbed(tab: .inbox, badges: [.inbox: 2]) { InboxScreen(inbox: phone.board.inbox) } } sheet: {
        AskBody(ask: ask.ask, more: 0, from: ask.asker) { _, _ in }.frame(maxHeight: .infinity, alignment: .top)
      }
    }
    phone.board.toasts.say(.init("Couldn't approve email.send. KOS didn't answer in time. Try again.", tone: .warn))
    try render("inbox-toast", only: ["390"]) {
      Tabbed(tab: .inbox, badges: [.inbox: 2]) { InboxScreen(inbox: phone.board.inbox).overlay(alignment: .bottom) { ToastLine(toasts: phone.board.toasts) } }
    }
  }

  @Test func anEmptyInboxAndAPageThatFailed() async throws {
    let phone = Phone.preview()
    online(phone)
    phone.board.inbox.waiting.value = Routes.Inbox(approvals: [])
    try render("inbox-empty", only: ["390"]) { Tabbed(tab: .inbox) { InboxScreen(inbox: phone.board.inbox) } }
    let failed = Page<[Routes.Project]> { throw Dashboard.Refusal("KOS didn't answer in time. Try again.") }
    // Asked, and not answered yet.
    let asked = Page<[Routes.Project]> { [] }
    try render("page-loading", only: ["390"]) {
      Tabbed(tab: .projects) { PageFrame { PageHead(title: "Projects") } content: { Loaded(page: asked, loading: "Reading your projects") { _ in EmptyView() } } }
    }
    await failed.refresh()
    try render("page-failed", only: ["390"]) {
      Tabbed(tab: .projects) {
        PageFrame { PageHead(title: "Projects") } content: { Loaded(page: failed, loading: "") { _ in EmptyView() } }
      }
    }
  }

  @Test func theArtifacts() throws {
    let phone = Phone.preview()
    online(phone)
    phone.board.gallery.all.value = try Self.read(Routes.List<Routes.Artifact>.self, Self.artifacts).items
    phone.board.gallery.trash.value = try Self.read(
      Routes.List<Routes.Artifact>.self, #"[{"id":"old-plan","title":"Old bed plan","kind":"html","artifactKind":"doc","updatedAt":\#(Self.ago(90000)),"trashedAt":\#(Self.ago(4000))}]"#
    ).items
    phone.board.projects.list.value = try Self.read(Routes.List<Routes.Project>.self, Self.projects).items
    try renderPage("artifacts") {
      Tabbed(tab: .artifacts) { GalleryScreen(gallery: phone.board.gallery, projects: phone.board.projects.list, shelf: phone.artifacts) }
    }
  }

  @Test func theProjectsAndOne() throws {
    let phone = Phone.preview()
    online(phone)
    phone.board.projects.list.value = try Self.read(Routes.List<Routes.Project>.self, Self.projects).items
    try renderPage("projects") { Tabbed(tab: .projects) { ProjectsScreen(projects: phone.board.projects) } }
    let page = phone.board.projects.page("garden")
    page.value = try Self.read(
      Routes.ProjectDetail.self,
      #"""
      {"project":{"slug":"garden","name":"Garden","type":"tracker","status":"active","description":"Four raised beds along the south fence, planted in two rounds.","colour":"#3ecf8e","lastTouchedAt":\#(Self.ago(12))},
       "tables":[{"name":"beds","rows":4,"columns":5},{"name":"plantings","rows":38,"columns":7},{"name":"costs","rows":6,"columns":6}],
       "pages":\#(Self.artifacts),
       "crons":[{"id":5,"name":"Water the beds","schedule":"0 7 * * *","type":"actions","enabled":true,"running":false,"lastRunAt":\#(Self.ago(200)),"nextRunAt":\#(Self.ago(-600))}],
       "agents":[{"id":"c9","title":"Bed layout","updatedAt":\#(Self.ago(30)),"activity":"idle","unread":true},{"id":"c10","title":"Seed order","updatedAt":\#(Self.ago(3000)),"activity":"needs-you"}],
       "folder":"projects/garden"}
      """#)
    try renderPage("project") {
      Tabbed(tab: .projects) { ProjectScreen(slug: "garden", name: "Garden", page: page, runs: phone.board.runs, shelf: phone.artifacts) }
    }
  }

  @Test func theMoreAndTheOverview() throws {
    let phone = Phone.preview()
    conversation(phone)
    phone.glance.received(Self.glance())
    try renderPage("more") { Tabbed(tab: .more, badges: [.inbox: 3, .more: 1]) { MoreScreen(phone: phone) } }
    phone.board.overview.home.value = try Self.read(
      Routes.Home.self,
      #"""
      {"approvals":[],"runs":\#((0..<24).map { #"{"id":\#($0),"kind":"cron","status":"\#($0 % 9 == 4 ? "error" : "ok")","startedAt":\#(Self.ago(Double($0) * 60))}"# }.joined(separator: ",").wrapped),
       "health":{"ok":false,"failing":[{"key":"cron:3","label":"Nightly backup","streak":3,"error":"rsync: write failed: No space left on device","since":\#(Self.ago(2880)),"lastAt":\#(Self.ago(400))}],"recent":{"total":24,"errors":3,"rate":0.12}},
       "projects":\#(Self.projects),"chats":[],
       "upcoming":[{"id":3,"name":"Nightly backup","at":\#(Self.ago(-180))},{"id":5,"name":"Water the beds","at":\#(Self.ago(-600))}],
       "spend":{"models":[{"provider":"anthropic","model":"claude","inputTokens":1,"outputTokens":1,"calls":212,"cost":4.31}],"byDay":[]},
       "memory":{"claims":48,"unread":0,"extraction":true,"decisions":0,"jobs":[]}}
      """#)
    try renderPage("overview") { Tabbed(tab: .more, badges: [.inbox: 3, .more: 1]) { OverviewScreen(overview: phone.board.overview, glance: phone.glance) } }
    try render("settings", only: ["390"]) { Tabbed(tab: .more) { SettingsScreen(phone: phone, reader: phone.reader) } }
  }

  @Test func theRuns() throws {
    let phone = Phone.preview()
    online(phone)
    phone.board.runs.crons.value = try Self.read(Routes.List<Routes.Cron>.self, Self.crons).items
    phone.board.runs.runs.value = try Self.read(Routes.List<Routes.Run>.self, Self.runs).items
    try renderPage("runs") { Tabbed(tab: .more) { RunsScreen(runs: phone.board.runs) } }
  }

  @Test func theBlobsAndOne() throws {
    let phone = Phone.preview()
    online(phone)
    phone.board.blobs.list.value = try Self.read(
      Routes.Blobs.self,
      #"""
      {"agents":[
        {"name":"scout","description":"Watches the prices of the things on your list and says when one drops.","folder":"blobs/scout","conversationId":"agent:scout","thread":{"id":"agent:scout","activity":"idle","unread":true,"updatedAt":\#(Self.ago(50)),"lastSaid":"The drill is down to $89 at the hardware store."},"job":{"id":8,"schedule":"0 9 * * 1-5","enabled":true,"lastRunAt":\#(Self.ago(300)),"nextRunAt":\#(Self.ago(-900))}},
        {"name":"inbox-sweep","description":"Reads new mail each morning and drafts the replies you would send.","folder":"blobs/inbox-sweep","conversationId":"agent:inbox-sweep","thread":{"id":"agent:inbox-sweep","activity":"needs-you","unread":false,"updatedAt":\#(Self.ago(3)),"lastSaid":null}},
        {"name":"tidy","description":"Keeps the workspace's notes folder in order.","folder":"blobs/tidy","conversationId":"agent:tidy","thread":{"id":"agent:tidy","activity":"error","unread":false,"updatedAt":\#(Self.ago(2000)),"lastSaid":null,"lastError":"timed out"}}
      ],"invalid":[]}
      """#
    ).agents
    phone.board.gallery.all.value = try Self.read(Routes.List<Routes.Artifact>.self, Self.artifacts).items
    try renderPage("blobs") { Tabbed(tab: .more) { BlobsScreen(blobs: phone.board.blobs) } }
    try renderPage("blob") {
      Tabbed(tab: .more) { BlobScreen(name: "scout", blobs: phone.board.blobs, gallery: phone.board.gallery, runs: phone.board.runs, shelf: phone.artifacts) }
    }
    let chat = phone.board.blobs.chat("agent:scout")
    chat.value = try Self.read(
      Routes.Transcript.self,
      #"{"messages":[{"role":"you","text":"Keep an eye on the cordless drill, the 18V one."},{"role":"kos","text":"On it. It's **$109** at the hardware store now; I'll say when it drops."},{"role":"kos","text":"The drill is down to **$89** at the hardware store, until Sunday."}]}"#)
    try renderPage("chat-read") { Tabbed(tab: .more) { ChatReadScreen(title: "scout", page: chat) } }
  }

  @Test func theFiles() throws {
    let phone = Phone.preview()
    online(phone)
    let folder = phone.board.files.folder("projects/garden")
    folder.value = try Self.read(
      Routes.Folder.self,
      #"""
      {"path":"projects/garden","entries":[
        {"name":"artifacts","path":"projects/garden/artifacts","kind":"dir","size":0,"modifiedAt":\#(Self.ago(25))},
        {"name":"photos","path":"projects/garden/photos","kind":"dir","size":0,"modifiedAt":\#(Self.ago(4000))},
        {"name":"bed-plan.pdf","path":"projects/garden/bed-plan.pdf","kind":"file","size":482133,"modifiedAt":\#(Self.ago(3000))},
        {"name":"notes.md","path":"projects/garden/notes.md","kind":"file","size":2304,"modifiedAt":\#(Self.ago(80))},
        {"name":"south-fence.jpg","path":"projects/garden/south-fence.jpg","kind":"file","size":1830221,"modifiedAt":\#(Self.ago(9000))}
      ]}
      """#)
    try renderPage("files") { Tabbed(tab: .more) { FolderScreen(path: "projects/garden", page: folder) } }
    let note = phone.board.files.file("projects/garden/notes.md")
    note.value = .text(
      try Self.read(
        Routes.File.self,
        ##"{"path":"projects/garden/notes.md","size":2304,"text":"# Garden notes\n\n- Bed 1 gets shade until 10am.\n- Order soil by the 20th; the yard delivers Saturdays.\n- Netting goes on after the peas are up.\n\n## Costs\n\nTimber, soil and seed come to about $640.","language":"markdown"}"##))
    try renderPage("file-text") { Tabbed(tab: .more) { FileScreen(name: "notes.md", page: note) } }
    let photo = phone.board.files.file("projects/garden/south-fence.jpg")
    photo.value = .picture(Self.receipt(), type: "image/png")
    try render("file-picture", only: ["390"]) { Tabbed(tab: .more) { FileScreen(name: "south-fence.jpg", page: photo) } }
  }

  @Test func theMemoryAndAClaim() throws {
    let phone = Phone.preview()
    online(phone)
    let claim = { (id: Int, key: String, value: String, tags: String, pinned: Bool, minutes: Double, kind: String) in
      #"{"id":\#(id),"key":"\#(key)","value":"\#(value)","kind":"\#(kind)","scope":"global","source":"c_1","tags":[\#(tags)],"pinned":\#(pinned),"trust":"owner","updatedAt":\#(Self.ago(minutes))}"#
    }
    phone.board.memory.claims.value = try Self.read(
      Routes.Memory.self,
      #"{"facts":[\#([claim(1, "diet.allergy", "No peanuts, ever. Tree nuts are fine.", #""food","health""#, true, 9000, "fact"), claim(2, "home.city", "Toronto, since March 2025", #""home""#, false, 30, "fact"), claim(3, "coffee", "Flat white, oat milk", #""food""#, false, 600, "preference"), claim(4, "car", "Blue 2019 Civic, plate ends 4KT", #""home""#, false, 20000, "fact")].joined(separator: ","))],"tags":[]}"#
    ).facts.sorted { ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt) }
    try renderPage("memory") { Tabbed(tab: .more) { MemoryScreen(memory: phone.board.memory) } }
    phone.board.memory.trace("home.city").value = try Self.read(
      Routes.Trace.self,
      #"{"before":[\#(claim(0, "home.city", "Ottawa", "", false, 400000, "fact"))],"evidence":[{"ts":\#(Self.ago(31)),"role":"owner","text":"We moved to Toronto in March, so use that for the weather."}]}"#)
    try renderPage("claim") { Tabbed(tab: .more) { ClaimScreen(key: "home.city", memory: phone.board.memory) } }
  }
}

private extension String {
  /// The list's items in brackets.
  var wrapped: String { "[\(self)]" }
}
