import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI
import WebKit

/// An artifact in a web view, held as the dashboard holds its frame
/// (`@kos/shared` artifactdoc.ts): the wrapper document KOS built, whose
/// sandboxed frame runs the page, its policy allowing no network. This side
/// is the dashboard's: a script of the phone's own, in a world of its own on
/// the wrapper, hears the page's frame alone and answers its window.kos.
/// Reads go to KOS; `open` opens another artifact on the phone, only just
/// after the owner's press in the frame; everything else is refused, since
/// the phone only shows. A deck is held as the dashboard holds one, its
/// controls the viewer's (DeckRemote), one slide at a time. A navigation anywhere is refused, a link off the
/// page opens in the browser only at the owner's tap, and a content rule
/// list blocks every load but the document's own, under the policy. The
/// same view runs on a Mac, where it is tested and drawn.
struct ArtifactFrame {
  let artifact: ArtifactShelf.Artifact
  let dark: Bool
  /// A read the page asked for, and where its answer goes.
  let read: (_ method: String, _ args: JSONValue, _ answer: @escaping (ArtifactShelf.Answer) -> Void) -> Void
  /// Another artifact, by its id, at the owner's press.
  let open: (String) -> Void
  /// A link off the page, at the owner's tap.
  let openLink: (URL) -> Void
  /// A deck's place, told up, and the viewer's presses, sent down.
  let deck: DeckRemote

  /// The world the phone's script and its messages live in: the page's own script never sees either.
  static let world = WKContentWorld.world(name: "kos-phone")
  /// How soon after the owner's press a page may open another artifact, as the dashboard holds it (frameheight.ts).
  static let pressMs = 500

  /// The phone's side of the frame: the page's calls and presses, and the theme and answers sent down.
  static let hostScript = """
    (function(){
    "use strict";
    var tell=function(m){window.webkit.messageHandlers.kos.postMessage(m)},pressed=-Infinity,port=null;
    function page(){var f=document.querySelector("iframe");return f?f.contentWindow:null}
    function down(m){var p=page();if(p)p.postMessage(m,"*")}
    addEventListener("message",function(e){
    var m=e.data||{};
    var p=page();if(!p||e.source!==p)return;
    if(m.__kos==="gestures"){if(port||!e.ports[0])return;port=e.ports[0];port.onmessage=function(){pressed=performance.now()};return}
    if(m.__kos==="error"){tell({error:String(m.message||"").slice(0,300)});return}
    if(m.__kos==="deck"){
    if(m.hosted!==true){down({__kos:"deck-do",action:"stage"});down({__kos:"deck-do",action:"host"})}
    tell({deck:{index:Number(m.index)||0,count:Number(m.count)||0}});return}
    if(m.__kos!=="call"||typeof m.id!=="number")return;
    var id=m.id,args=m.args&&typeof m.args==="object"?m.args:{};
    if(m.method==="query"||m.method==="file"){tell({read:{call:id,method:m.method,args:args}});return}
    if(m.method==="open"){
    if(performance.now()-pressed>\(pressMs))return down({__kos:"reply",id:id,error:"an artifact opens only at the owner's press"});
    tell({open:String(args.id||"")});return down({__kos:"reply",id:id,result:{opened:true}})}
    down({__kos:"reply",id:id,error:"KOS for iPhone only shows this artifact: nothing in it changes here"});
    });
    window.__kosPhone=Object.freeze({
    reply:function(id,body){down(Object.assign({__kos:"reply",id:id},body))},
    theme:function(mode,rule){down({__kos:"theme",mode:mode,rule:rule})},
    deck:function(action){if(action==="prev"||action==="next")down({__kos:"deck-do",action:action})},
    pressedLately:function(){return performance.now()-pressed<=\(pressMs)}
    });
    })();
    """

  /// Every load blocked but the document's own: under the policy, so a page that slipped it still reaches nothing.
  static let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}}]"#

  @MainActor
  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var frame: ArtifactFrame
    weak var view: WKWebView?
    /// The document loaded, by the artifact it is, so a redraw of the same one keeps its place.
    var loaded: ArtifactShelf.Artifact?
    var dark: Bool?
    /// The wrapper and the page's frame have each loaded once; another load of the page's is it leaving.
    private var loads = 0
    private var ruled = false

    init(_ frame: ArtifactFrame) {
      self.frame = frame
    }

    func load(into view: WKWebView) {
      let artifact = frame.artifact
      frame.deck.press = { [weak view] action in
        view?.callAsyncJavaScript("window.__kosPhone&&window.__kosPhone.deck(action)", arguments: ["action": action], in: nil, in: ArtifactFrame.world)
      }
      guard loaded != artifact else { return themed(view) }
      loaded = artifact
      dark = artifact.dark
      loads = 0
      // A new document says where its deck is again; told after this update, as SwiftUI asks.
      let deck = frame.deck
      Task { deck.place = nil }
      Task {
        if !ruled, let rules = await ArtifactFrame.ruleList() {
          view.configuration.userContentController.add(rules)
          ruled = true
        }
        guard loaded == artifact else { return }
        view.loadHTMLString(artifact.document, baseURL: nil)
      }
    }

    /// The phone's theme, followed in place: the page is told, as the dashboard tells it, and keeps its place.
    func themed(_ view: WKWebView) {
      guard let artifact = loaded, dark != frame.dark else { return }
      dark = frame.dark
      let rule = frame.dark ? artifact.themes.dark : artifact.themes.light
      view.callAsyncJavaScript(
        "window.__kosPhone&&window.__kosPhone.theme(mode,rule)", arguments: ["mode": frame.dark ? "dark" : "light", "rule": rule], in: nil,
        in: ArtifactFrame.world)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      // The phone's own script, in the wrapper's frame: nothing the page's frame posts is heard here.
      guard message.frameInfo.isMainFrame, message.world == ArtifactFrame.world, let body = message.body as? [String: Any] else { return }
      if let read = body["read"] as? [String: Any], let call = read["call"] as? Int, let method = read["method"] as? String {
        let args = (try? JSONSerialization.data(withJSONObject: read["args"] ?? [:])).flatMap { JSONValue(json: $0) } ?? .object([:])
        frame.read(method, args) { [weak self] answer in self?.reply(call, answer) }
      } else if let id = body["open"] as? String, ArtifactLink.isId(id) {
        frame.open(id)
      } else if let place = body["deck"] as? [String: Any], let index = place["index"] as? Int, let count = place["count"] as? Int {
        frame.deck.place = count > 0 ? DeckRemote.Place(index: min(max(index, 0), count - 1), count: count) : nil
      }
    }

    private func reply(_ call: Int, _ answer: ArtifactShelf.Answer) {
      let body: Any
      switch answer {
      case .success(let result): body = ["result": (try? JSONSerialization.jsonObject(with: result.json, options: .fragmentsAllowed)) ?? NSNull()]
      case .failure(let refusal): body = ["error": refusal.message]
      }
      view?.callAsyncJavaScript("window.__kosPhone&&window.__kosPhone.reply(id,body)", arguments: ["id": call, "body": body], in: nil, in: ArtifactFrame.world)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      let url = action.request.url
      // The wrapper, then the page's frame, each once: nothing else loads in the view.
      if loads < 2, url?.scheme == "about", action.navigationType == .other {
        loads += 1
        return decisionHandler(.allow)
      }
      decisionHandler(.cancel)
      guard action.navigationType == .linkActivated, let url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
      // A link off the page opens in the browser only at the owner's own tap, as the frame's channel says.
      webView.callAsyncJavaScript("return !!(window.__kosPhone&&window.__kosPhone.pressedLately())", arguments: [:], in: nil, in: ArtifactFrame.world) {
        [weak self] result in
        if case .success(let pressed as Bool) = result, pressed { self?.frame.openLink(url) }
      }
    }

    /// No window of its own: a page's window.open is refused.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
      nil
    }
  }

  @MainActor
  func makeView(_ coordinator: Coordinator) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.userContentController.add(coordinator, contentWorld: Self.world, name: "kos")
    config.userContentController.addUserScript(WKUserScript(source: Self.hostScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.world))
    #if os(iOS)
      config.dataDetectorTypes = []
    #endif
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = coordinator
    view.uiDelegate = coordinator
    view.allowsLinkPreview = false
    #if os(iOS)
      view.isOpaque = false
      view.backgroundColor = .clear
      view.scrollView.backgroundColor = .clear
      view.scrollView.contentInsetAdjustmentBehavior = .never
    #else
      view.setValue(false, forKey: "drawsBackground")
    #endif
    coordinator.view = view
    return view
  }

  /// The rule list, compiled once.
  @MainActor
  static func ruleList() async -> WKContentRuleList? {
    if let compiled { return compiled }
    compiled = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "kos-phone-artifact", encodedContentRuleList: rules)
    return compiled
  }

  @MainActor private static var compiled: WKContentRuleList?
}

#if os(iOS)
  extension ArtifactFrame: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView { makeView(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {
      context.coordinator.frame = self
      context.coordinator.load(into: view)
    }
  }
#else
  extension ArtifactFrame: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView { makeView(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {
      context.coordinator.frame = self
      context.coordinator.load(into: view)
    }
  }
#endif

/// A deck's place in the viewer, as the deck reports it, and the viewer's presses on its way back: the dashboard's
/// head draws a deck's controls the same way.
@MainActor
final class DeckRemote: ObservableObject {
  struct Place: Equatable {
    let index: Int
    let count: Int
  }

  @Published var place: Place?
  /// Sends "prev" or "next" down to the deck; the frame sets it.
  var press: (String) -> Void = { _ in }

  init(place: Place? = nil) {
    self.place = place
  }
}
