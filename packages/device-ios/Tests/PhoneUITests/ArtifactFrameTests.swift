import AppKit
import DeviceCore
import Network
import Testing
import WebKit

@testable import PhoneCore
@testable import PhoneUI

/// The viewer's web view held as the dashboard holds an artifact's frame: a page speaking the bridge's wire
/// (artifactdoc.ts) reaches the phone only through it, reads go to KOS, everything else is refused, and it can
/// neither leave nor reach the network nor the phone's own script.
@MainActor
@Suite("The artifact frame", .serialized)
struct ArtifactFrameTests {
  /// What the page found, as it reports it up to the wrapper.
  final class Heard: NSObject, WKScriptMessageHandler {
    var said: [String] = []
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      if let words = message.body as? String { said.append(words) }
    }
  }

  /// A page as an artifact's frame runs one: its calls go to the wrapper as the bridge sends them, and what it finds goes
  /// up as a report the test hears.
  private static let page = """
    <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"></head><body><script>
    var seq=0,waiting={};
    function report(s){top.postMessage({__kos:"test",said:String(s)},"*")}
    function call(method,args){return new Promise(function(ok,no){var id=++seq;waiting[id]={ok:ok,no:no};top.postMessage({__kos:"call",id:id,method:method,args:args},"*")})}
    addEventListener("message",function(e){var m=e.data||{};if(e.source!==top||m.__kos!=="reply")return;var w=waiting[m.id];if(!w)return;delete waiting[m.id];m.error?w.no(new Error(m.error)):w.ok(m.result)});
    report("handler:"+(typeof window.webkit!=="undefined"&&!!(window.webkit.messageHandlers||{}).kos));
    report("phone:"+(typeof window.__kosPhone!=="undefined"));
    fetch("https://example.com/").then(function(){report("fetched")},function(){report("fetch refused")});
    call("query",{sql:"SELECT 1"}).then(function(r){report("query:"+JSON.stringify(r))},function(e){report("query refused:"+e.message)});
    call("save",{edit:{}}).catch(function(e){report("save:"+e.message)});
    call("write",{table:"t",op:"insert",values:{}}).catch(function(e){report("write:"+e.message)});
    call("open",{id:"budget"}).catch(function(e){report("open:"+e.message)});
    setTimeout(function(){location.href="https://example.com/away"},100);
    </script></body></html>
    """

  private static func wrapper(_ page: String) -> String {
    let attr = page.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
    return "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:\"></head><body><iframe sandbox=\"allow-scripts\" srcdoc=\"\(attr)\"></iframe></body></html>"
  }

  @Test func readsGoToKOSAndEverythingElseIsRefused() async throws {
    var reads: [(String, JSONValue)] = []
    var opened: [String] = []
    var cannot: [String] = []
    let artifact = ArtifactShelf.Artifact(id: "plan", title: "Plan", kind: "doc", document: Self.wrapper(Self.page), themes: .init(light: "", dark: ""), dark: false)
    let frame = ArtifactFrame(
      artifact: artifact, dark: false,
      read: { method, args, answer in
        reads.append((method, args))
        answer(.success(.object(["rows": .array([.object(["n": .number(1)])])])))
      },
      open: { opened.append($0) }, row: { _ in }, cannot: { cannot.append($0) }, deck: DeckRemote())
    let coordinator = ArtifactFrame.Coordinator(frame)
    let view = frame.makeView(coordinator)
    let heard = Heard()
    view.configuration.userContentController.add(heard, contentWorld: ArtifactFrame.world, name: "test")
    view.configuration.userContentController.addUserScript(
      WKUserScript(
        source: #"addEventListener("message",function(e){var m=e.data||{};if(m.__kos==="test")window.webkit.messageHandlers.test.postMessage(m.said)})"#,
        injectionTime: .atDocumentStart, forMainFrameOnly: true, in: ArtifactFrame.world))
    view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
    coordinator.load(into: view)
    for _ in 0..<60 where heard.said.count < 7 { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(700))

    // The page has neither the phone's handler nor its script: both live in a world of their own.
    #expect(heard.said.contains("handler:false"))
    #expect(heard.said.contains("phone:false"))
    #expect(heard.said.contains("fetch refused"))
    #expect(heard.said.contains(#"query:{"rows":[{"n":1}]}"#))
    #expect(reads.map(\.0) == ["query"])
    #expect(reads.first?.1 == .object(["sql": .string("SELECT 1")]))
    #expect(heard.said.contains("save:KOS for iPhone only shows this artifact: nothing in it changes here"))
    #expect(heard.said.contains("write:KOS for iPhone only shows this artifact: nothing in it changes here"))
    // Nobody pressed: another artifact is not opened. The page's try at leaving goes nowhere: the view stays on its
    // own document, and a page that tried is not heard from again, as the dashboard removes one.
    #expect(heard.said.contains("open:an artifact opens only at the owner's press"))
    #expect(opened.isEmpty)
    #expect(view.url?.absoluteString == "about:blank")
    #expect(cannot.isEmpty)
  }

  /// A page that tells a row up, unasked, then once a press is stamped on its gesture port, as the bridge stamps one.
  private static func rowPage(pressed: Bool) -> String {
    """
    <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"></head><body><script>
    var fields=[];for(var i=0;i<250;i++)fields.push({label:"Column "+i,value:i===1?"x".repeat(5000):String(i),numeric:i%2===0});
    var g=new MessageChannel();top.postMessage({__kos:"gestures"},"*",[g.port2]);
    top.postMessage({__kos:"row",sheet:"Unasked",title:"Unasked",fields:[]},"*");
    setTimeout(function(){\(pressed ? "g.port1.postMessage(0);" : "")setTimeout(function(){
    top.postMessage({__kos:"row",sheet:"Costs",title:"Cedar boards",fields:fields},"*");
    top.postMessage({__kos:"row",title:7,fields:"no"},"*")},50)},200);
    </script></body></html>
    """
  }

  private func rows(kind: String, pressed: Bool) async throws -> [ArtifactShelf.Row] {
    var rows: [ArtifactShelf.Row] = []
    let artifact = ArtifactShelf.Artifact(id: "costs", title: "Costs", kind: kind, document: Self.wrapper(Self.rowPage(pressed: pressed)), themes: .init(light: "", dark: ""), dark: false)
    let frame = ArtifactFrame(artifact: artifact, dark: false, read: { _, _, _ in }, open: { _ in }, row: { rows.append($0) }, cannot: { _ in }, deck: DeckRemote())
    let coordinator = ArtifactFrame.Coordinator(frame)
    let view = frame.makeView(coordinator)
    view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
    coordinator.load(into: view)
    for _ in 0..<40 where rows.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(400))
    return rows
  }

  @Test func aRowIsHeardOnlyFromASheetJustAfterThePress() async throws {
    #expect(try await rows(kind: "sheet", pressed: false).isEmpty)
    #expect(try await rows(kind: "doc", pressed: true).isEmpty)
  }

  @Test func aSheetsRowTappedGoesUpHeldToTheRuntimesCaps() async throws {
    let rows = try await rows(kind: "sheet", pressed: true)
    let row = try #require(rows.first)
    #expect(rows.count == 1)
    #expect(row.sheet == "Costs" && row.title == "Cedar boards")
    #expect(row.fields.count == ArtifactShelf.Row.most)
    #expect(row.fields[1].value.count == ArtifactShelf.Row.longest)
    #expect(row.fields[0] == .init(label: "Column 0", value: "0", numeric: true))
  }

  @Test func onlyADocOpensAnotherArtifact() {
    #expect(ArtifactFrame.openRefusal(kind: "doc", id: "budget") == nil)
    #expect(ArtifactFrame.openRefusal(kind: "deck", id: "budget") == "only a doc can open an artifact")
    #expect(ArtifactFrame.openRefusal(kind: "page", id: "budget") == "only a doc can open an artifact")
    #expect(ArtifactFrame.openRefusal(kind: "doc", id: "../etc") == "that is not an artifact's id")
  }

  /// A page with no policy of its own, loading a picture from a server on this Mac.
  private static func fetching(_ port: UInt16) -> String {
    #"<!doctype html><html><body><img src="http://127.0.0.1:\#(port)/p.png" onload="report('loaded')" onerror="report('blocked')"><script>function report(s){(window.webkit&&window.webkit.messageHandlers.test?window.webkit.messageHandlers.test:{postMessage:function(m){top.postMessage({__kos:'test',said:m},'*')}}).postMessage(s)}</script></body></html>"#
  }

  @Test func blocksEveryLoadButTheDocumentsOwnUnderAnyPolicy() async throws {
    let server = try PictureServer()
    // Unheld, the page loads the picture: the server answers.
    let plain = WKWebView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    let control = Heard()
    plain.configuration.userContentController.add(control, name: "test")
    plain.loadHTMLString(Self.fetching(server.port), baseURL: nil)
    for _ in 0..<60 where control.said.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
    #expect(control.said == ["loaded"])
    let served = server.requests

    // Held by the viewer, with no policy in the way, the rule list alone refuses it before any request goes.
    let page = Self.fetching(server.port).replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
    let document = "<!doctype html><html><body><iframe sandbox=\"allow-scripts\" srcdoc=\"\(page)\"></iframe></body></html>"
    let artifact = ArtifactShelf.Artifact(id: "plan", title: "Plan", kind: "doc", document: document, themes: .init(light: "", dark: ""), dark: false)
    let frame = ArtifactFrame(artifact: artifact, dark: false, read: { _, _, _ in }, open: { _ in }, row: { _ in }, cannot: { _ in }, deck: DeckRemote())
    let coordinator = ArtifactFrame.Coordinator(frame)
    let view = frame.makeView(coordinator)
    let heard = Heard()
    view.configuration.userContentController.add(heard, contentWorld: ArtifactFrame.world, name: "test")
    view.configuration.userContentController.addUserScript(
      WKUserScript(
        source: #"addEventListener("message",function(e){var m=e.data||{};if(m.__kos==="test")window.webkit.messageHandlers.test.postMessage(m.said)})"#,
        injectionTime: .atDocumentStart, forMainFrameOnly: true, in: ArtifactFrame.world))
    coordinator.load(into: view)
    for _ in 0..<60 where heard.said.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
    #expect(heard.said == ["blocked"])
    #expect(server.requests == served)
  }

  @Test func showsNothingWhenTheRulesDoNotHold() async throws {
    var cannot: [String] = []
    let artifact = ArtifactShelf.Artifact(id: "plan", title: "Plan", kind: "doc", document: Self.wrapper(Self.page), themes: .init(light: "", dark: ""), dark: false)
    let frame = ArtifactFrame(artifact: artifact, dark: false, read: { _, _, _ in }, open: { _ in }, row: { _ in }, cannot: { cannot.append($0) }, deck: DeckRemote())
    let coordinator = ArtifactFrame.Coordinator(frame, rules: { nil })
    let view = frame.makeView(coordinator)
    coordinator.load(into: view)
    for _ in 0..<40 where cannot.isEmpty { try await Task.sleep(for: .milliseconds(25)) }
    #expect(cannot == ["the viewer's content rules did not compile"])
    try await Task.sleep(for: .milliseconds(200))
    #expect(view.url == nil && !view.isLoading)
  }
}

/// A server on this Mac's loopback answering every request with a one-pixel PNG, counting them.
final class PictureServer: @unchecked Sendable {
  private let listener: NWListener
  private let lock = NSLock()
  private var count = 0

  init() throws {
    listener = try NWListener(using: .tcp, on: .any)
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    listener.newConnectionHandler = { [weak self] connection in
      connection.start(queue: .global())
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, _, _ in
        self?.lock.withLock { self?.count += 1 }
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")!
        let head = "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: \(png.count)\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + png, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    listener.start(queue: .global())
    _ = ready.wait(timeout: .now() + 5)
  }

  var port: UInt16 { listener.port?.rawValue ?? 0 }

  var requests: Int { lock.withLock { count } }

  deinit { listener.cancel() }
}
