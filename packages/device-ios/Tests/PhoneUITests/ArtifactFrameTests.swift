import AppKit
import DeviceCore
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
    setTimeout(function(){location.href="https://example.com/away";setTimeout(function(){report("still here")},400)},100);
    </script></body></html>
    """

  private static func wrapper(_ page: String) -> String {
    let attr = page.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
    return "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:\"></head><body><iframe sandbox=\"allow-scripts\" srcdoc=\"\(attr)\"></iframe></body></html>"
  }

  @Test func readsGoToKOSAndEverythingElseIsRefused() async throws {
    var reads: [(String, JSONValue)] = []
    var opened: [String] = []
    var links: [URL] = []
    let artifact = ArtifactShelf.Artifact(id: "plan", title: "Plan", kind: "doc", document: Self.wrapper(Self.page), themes: .init(light: "", dark: ""), dark: false)
    let frame = ArtifactFrame(
      artifact: artifact, dark: false,
      read: { method, args, answer in
        reads.append((method, args))
        answer(.success(.object(["rows": .array([.object(["n": .number(1)])])])))
      },
      open: { opened.append($0) }, openLink: { links.append($0) }, deck: DeckRemote())
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
    for _ in 0..<60 where !heard.said.contains("still here") { try await Task.sleep(for: .milliseconds(50)) }

    // The page has neither the phone's handler nor its script: both live in a world of their own.
    #expect(heard.said.contains("handler:false"))
    #expect(heard.said.contains("phone:false"))
    #expect(heard.said.contains("fetch refused"))
    #expect(heard.said.contains(#"query:{"rows":[{"n":1}]}"#))
    #expect(reads.map(\.0) == ["query"])
    #expect(reads.first?.1 == .object(["sql": .string("SELECT 1")]))
    #expect(heard.said.contains("save:KOS for iPhone only shows this artifact: nothing in it changes here"))
    #expect(heard.said.contains("write:KOS for iPhone only shows this artifact: nothing in it changes here"))
    // Nobody pressed: another artifact is not opened, and the page did not leave.
    #expect(heard.said.contains("open:an artifact opens only at the owner's press"))
    #expect(opened.isEmpty)
    #expect(heard.said.contains("still here"))
    #expect(links.isEmpty)
  }

  @Test func blocksEveryLoadButTheDocumentsOwn() async throws {
    let rules = try #require(await ArtifactFrame.ruleList())
    #expect(rules.identifier == "kos-phone-artifact")
  }
}
