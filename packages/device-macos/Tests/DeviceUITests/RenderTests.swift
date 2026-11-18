import AppKit
import DeviceCore
import SwiftUI
import Testing

@testable import DeviceUI

/// Every window state lays out at a sane size, drawn offscreen as the app would.
///
/// Each is drawn in both themes. With KOS_SNAPSHOT_DIR set, each is also
/// written there as a PNG, `name-dark.png` and `name-light.png`, so a change
/// to the look can be seen without pairing a Mac or asking for a session.
@MainActor
@Suite("Windows render")
struct RenderTests {
  /// `height`: drawn in a window that tall, as the home window is drawn at its one height.
  private func render<V: View>(_ name: String, _ view: V, height: CGFloat? = nil, width: CGFloat = 460) throws -> CGSize {
    var sizes: [CGSize] = []
    for (theme, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
      let host = NSHostingView(rootView: view)
      let size = height.map { CGSize(width: width, height: $0) } ?? host.fittingSize
      host.frame = CGRect(origin: .zero, size: size)
      let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
      window.appearance = NSAppearance(named: appearance)
      window.contentView = host
      host.layoutSubtreeIfNeeded()
      if let dir = ProcessInfo.processInfo.environment["KOS_SNAPSHOT_DIR"] {
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try #require(rep.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(theme).png"))
      }
      sizes.append(size)
    }
    // A theme is colours only: the same window, the same size.
    #expect(sizes.first == sizes.last, "\(name) changed size with the theme")
    return sizes[0]
  }

  private func kos(
    _ id: String = "d1", host: String = "127.0.0.1:4417", link: LinkState = .connected, askFirst: Bool = true
  ) -> KOSEntry {
    KOSEntry(id: id, host: host, dashboard: URL(string: "http://\(host)"), deviceName: "Studio MacBook", link: link, askFirst: askFirst)
  }

  private func home(_ configure: (HomeModel) -> Void) -> HomeModel {
    let model = HomeModel()
    model.hidden = [
      AppEntry(id: "com.1password.1password", name: "1Password", icon: nil),
      AppEntry(id: "com.bitwarden.desktop", name: "Bitwarden", icon: nil, installed: false),
      AppEntry(id: "com.dashlane.Dashlane", name: "Dashlane", icon: nil, installed: false),
      AppEntry(id: "com.apple.keychainaccess", name: "Keychain Access", icon: nil),
    ]
    configure(model)
    return model
  }

  @Test func homeWhenNotPaired() throws {
    let model = home {
      $0.address = "http://127.0.0.1:4417"
      $0.code = "RFMA-DGDT"
      $0.name = "Studio MacBook"
      $0.note = "Check this is your KOS, then press Pair."
      $0.devicesPage = URL(string: "http://127.0.0.1:4417/#/settings/devices")
    }
    let size = try render("home-unpaired", HomeView(model: model), height: HomeView.height)
    #expect(size == CGSize(width: 460, height: HomeView.height))
  }

  /// KOS as the owner set it there (shape "mochi", a violet, eyes with a glint), drawn as it sent it.
  @Test func homeInTheFaceItsKOSSent() throws {
    let model = home {
      $0.kos = [kos()]
      $0.screenGranted = true
      $0.inputGranted = true
      $0.face = FaceLook(
        fill: 0x8B5CF6, ink: 0x1A1429, eyes: .sparkle, gait: 1,
        shape: FaceLook.Shape(aspect: 1.0360, squat: 0.1200, spread: 0.9768, lobes: [FaceLook.Lobe(k: 2, amp: 0.0206, phase: 1.4140), FaceLook.Lobe(k: 3, amp: 0.0180, phase: 1.8343), FaceLook.Lobe(k: 4, amp: 0.0084, phase: 0.9776)]))
    }
    let size = try render("home-faced", HomeView(model: model), height: HomeView.height)
    #expect(size == CGSize(width: 460, height: HomeView.height))
  }

  /// KOS's word that an update waits on the owner's signing key, the command to set it up, and one under way.
  @Test func homeWithAnUpdateNotice() throws {
    let build = Build(id: "0123456789ab", commit: String(repeating: "b", count: 40))
    let signing = home {
      $0.kos = [kos()]
      $0.screenGranted = true
      $0.inputGranted = true
      $0.update = UpdateNotice(state: .behind, build: build, reason: .signing, command: "cd ~/Documents/kos-agent/packages/device-macos && scripts/signing.sh setup")
    }
    #expect(try render("home-update-signing", HomeView(model: signing), height: HomeView.height) == CGSize(width: 460, height: HomeView.height))
    let failed = home {
      $0.kos = [kos()]
      $0.screenGranted = true
      $0.inputGranted = true
      $0.update = UpdateNotice(state: .behind, build: build, reason: .failed, detail: "the signing key is locked, and macOS asks for its PIN only in your own Terminal", command: "cd ~/Documents/kos-agent/packages/device-macos && scripts/bundle.sh --install")
      $0.commandCopied = true
    }
    #expect(try render("home-update-failed", HomeView(model: failed), height: HomeView.height) == CGSize(width: 460, height: HomeView.height))
    let updating = home {
      $0.kos = [kos()]
      $0.screenGranted = true
      $0.inputGranted = true
      $0.update = UpdateNotice(state: .updating, build: build)
    }
    #expect(try render("home-update-updating", HomeView(model: updating), height: HomeView.height) == CGSize(width: 460, height: HomeView.height))
  }

  /// The chat window, mid-conversation: the owner's words, KOS's markdown, a turn's steps folded, and an approval waiting.
  @Test func chatWindow() throws {
    let model = ChatModel()
    model.paired = true
    model.link = .connected
    model.beside = "Keynote"
    model.besideTitle = "Q3 review.key"
    model.models(.init(current: "gpt-5.5", choices: ["gpt-5.5", "gpt-5.4-mini"]))
    model.show(
      conversation: "mac:owner", title: "Q3 deck review",
      lines: [
        .you("What slides in this deck still need numbers?", files: []),
        .steps([.init(summary: "Use Studio MacBook: Keynote"), .init(summary: "Look at the screen")]),
        .kos("Three slides are missing figures:\n\n1. **Revenue** (slide 4): the Q3 total\n2. **Churn** (slide 7)\n   - monthly, not quarterly\n3. **Hiring** (slide 9)\n\n| Slide | Missing |\n| --- | --- |\n| 4 | Q3 revenue |\n| 7 | Churn rate |\n\nWant me to fill them from `finance.xlsx`?"),
        .you("Yes, use the September sheet", files: []),
      ])
    model.ask(.init(id: "7", tool: "computer.act", args: "{\"actions\":[{\"type\":\"click\",\"x\":412,\"y\":220}]}", why: "Type the Q3 revenue into slide 4.", always: "Always in Keynote"))
    let size = try render("chat-window", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    #expect(size.height == ChatView.size.height)
  }

  /// A picture of a screen, as a step would have taken: a window over a desktop, in one colour each.
  private func screenshot(_ hue: CGFloat) throws -> String {
    let w = 1232, h = 800
    let context = try #require(CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(NSColor(hue: hue, saturation: 0.35, brightness: 0.55, alpha: 1).cgColor)
    context.fill(CGRect(x: 0, y: 0, width: w, height: h))
    context.setFillColor(NSColor(white: 0.96, alpha: 1).cgColor)
    context.fill(CGRect(x: 160, y: 120, width: 900, height: 560))
    context.setFillColor(NSColor(hue: hue, saturation: 0.7, brightness: 0.8, alpha: 1).cgColor)
    context.fill(CGRect(x: 200, y: 560, width: 360, height: 60))
    let rep = NSBitmapImageRep(cgImage: try #require(context.makeImage()))
    return try #require(rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])).base64EncodedString()
  }

  /// A turn on the go in the chat: an earlier turn's steps with what they saw, then this one's steps live, its
  /// pictures under them, and the foot thinking after a finished step.
  @Test func chatWindowMidTurnWithPictures() async throws {
    let model = ChatModel()
    model.paired = true
    model.link = .connected
    model.beside = "Safari"
    model.besideTitle = "Quizzes · Course"
    model.models(.init(current: "", choices: [], fixed: "Claude Agent SDK"))
    let shots = [1: try screenshot(0.6), 2: try screenshot(0.08), 3: try screenshot(0.33), 4: try screenshot(0.75)]
    model.show(
      conversation: "mac:owner", title: "Quiz form",
      lines: [
        .you("Open the quizzes page", files: []),
        .steps([.init(summary: "Open Safari", frame: 1)]),
        .kos("It is open on the Quizzes tab."),
        .you("Now fill in the engagement form", files: []),
      ],
      pictures: [1: shots[1]!])
    model.status(taken: true, story: nil, error: nil, said: "Now fill in the engagement form", conversation: "mac:owner")
    model.session = .working
    model.status(taken: false, story: .some("› Open the engagement form (done)\n› Type the student number (done)"), error: nil, said: "Now fill in the engagement form", conversation: "mac:owner")
    for id in [2, 3, 4] { model.frame(id, image: shots[id]!, said: "Now fill in the engagement form", conversation: "mac:owner") }
    // Decoded before the picture is drawn, as the window would have them by the time they show.
    for (id, data) in model.pictures { _ = await Thumbnails.shared.image(.init(id: id), from: data) }
    #expect(model.foot == "Thinking")
    let size = try render("chat-window-mid-turn", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    #expect(size.height == ChatView.size.height)
  }

  /// A time KOS wrote, as its words on the dashboard's grey chip.
  @Test func chatMarkdownWithATime() throws {
    let due = Int(Date().timeIntervalSince1970) + 13 * 86_400
    let view = ChatMarkdown("The deadline is <t:\(due):R>, so there is still time.").foregroundStyle(Theme.text).padding(16).background(Theme.bg)
    let size = try render("chat-time", view.frame(width: 420))
    #expect(size.height > 0)
  }

  /// Before a word: what to ask, under the app card; and a turn that has taken no step yet, then one at a step, while a session runs.
  @Test func chatWindowEmptyThinkingAndAtAStep() throws {
    let model = ChatModel()
    model.paired = true
    model.link = .connected
    model.beside = "Keynote"
    model.besideTitle = "Q3 review.key"
    model.models(.init(current: "", choices: [], fixed: "Claude Agent SDK"))
    model.show(conversation: nil, title: "Mac", lines: [])
    _ = try render("chat-window-empty", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    model.say("Tidy the title slide")
    _ = try render("chat-window-thinking", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    model.session = .working
    model.status(taken: false, story: .some("› Use Studio MacBook: Keynote\n› Look at the screen\nThe title runs over two lines."), error: nil)
    _ = try render("chat-window-step", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    // Words after the steps, the turn still going: the foot under them still says it works.
    #expect(model.foot == "Working")
    let size = try render("chat-window-words-then-working", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    #expect(size.height == ChatView.size.height)
  }

  /// The empty chat in the middle of the thread, as the side panel's is, with nothing to scroll (and so no thumb).
  @Test func theEmptyChatFitsItsThread() throws {
    let model = ChatModel()
    model.paired = true
    model.link = .connected
    model.show(conversation: nil, title: "Mac", lines: [])
    let host = NSHostingView(rootView: ChatView(model: model))
    host.frame = CGRect(origin: .zero, size: ChatView.size)
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = host
    // The thread is measured, then the empty chat takes that height: a pass or two.
    for _ in 0..<5 {
      host.layoutSubtreeIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    let thread = try #require(OverlayScrollTests.scrollView(in: host))
    let page = try #require(thread.documentView)
    // The empty chat fills the thread (it is in the middle) and no more (it does not scroll), whatever the host's sizes.
    #expect(page.frame.height >= thread.contentView.bounds.height - 1, "the empty chat is \(page.frame.height) in a thread \(thread.contentView.bounds.height) tall")
    #expect(page.frame.height <= thread.contentView.bounds.height + 0.5, "the empty chat scrolls by \(page.frame.height - thread.contentView.bounds.height)")
  }

  /// A turn going: Stop in the box; asking on the screen; the owner holding the Mac; then a selection on its way, with a menu open.
  @Test func chatWindowStopAskPausedAndSelection() throws {
    let model = ChatModel()
    model.paired = true
    model.link = .connected
    model.beside = "Notes"
    model.besideTitle = "Draft"
    model.show(conversation: "mac:owner", title: "Tidy notes", lines: [.you("Fix the typos in this note", files: [])])
    model.status(taken: false, story: .some("› Use Studio MacBook: Notes"), error: nil, said: "Fix the typos in this note", conversation: "mac:owner")
    _ = try render("chat-composer-stop", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    model.consent = .init(task: "Fix the typos in the Draft note", until: Date().addingTimeInterval(52))
    _ = try render("chat-consent", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    model.consent = nil
    model.session = .paused
    _ = try render("chat-paused", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    model.session = nil
    model.status(taken: false, story: .some(nil), error: nil, said: "Fix the typos in this note", conversation: "mac:owner")
    model.ask(.init(id: "3", tool: "computer.act", mechanics: "Type “the cat”", expires: Date().addingTimeInterval(95)))
    model.selected(.init(text: "teh cat sat on teh mat", from: "Notes: Draft"))
    model.draft = "/s"
    _ = try render("chat-selection", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    // A long selection, cut to two lines; and one sent, above the owner's words.
    model.draft = ""
    model.settled("3")
    let long = "Workers may see and work. Each runs in its own container with the tools its tier allows, and the owner approves anything that reaches outside it, from a purchase to a message sent in their name."
    model.selected(.init(text: long, from: "Safari: KOS design notes"))
    model.show(conversation: "mac:owner", title: "Tidy notes", lines: [.you("What does this mean for the jail?", files: [], quote: .init(text: long, from: "Safari: KOS design notes")), .kos("Each worker is boxed in by its tier.")])
    let size = try render("chat-selection-long", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    #expect(size.height == ChatView.size.height)
  }

  /// Paired with nothing, and paired with a KOS that never answers this window.
  @Test func chatWindowUnpairedAndSilent() throws {
    let model = ChatModel()
    model.beside = "Keynote"
    _ = try render("chat-window-unpaired", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    model.paired = true
    model.link = .connected
    model.silent = true
    let size = try render("chat-window-silent", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    #expect(size.height == ChatView.size.height)
  }

  /// Without Accessibility, the line over the box that says why nothing selected comes in; gone with the next words.
  @Test func chatWindowWithTheAccessibilityHint() throws {
    let model = ChatModel()
    model.paired = true
    model.link = .connected
    model.beside = "Safari"
    model.show(conversation: nil, title: "Mac", lines: [])
    model.hint = "Allow Accessibility for KOS for Mac, in System Settings, Privacy & Security, to bring in what you select."
    let size = try render("chat-access-hint", ChatView(model: model), height: ChatView.size.height, width: ChatView.size.width)
    #expect(size.height == ChatView.size.height)
    model.say("hello")
    #expect(model.hint == nil)
  }

  /// Paired, connected and granted, nothing open: the state the Chrome popup is compared with.
  @Test func homeWhenConnected() throws {
    let model = home {
      $0.kos = [kos(host: "127.0.0.1:4317")]
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-connected", HomeView(model: model), height: HomeView.height)
    #expect(model.headKOS?.host == "127.0.0.1:4317")
  }

  /// The head's pill and host are one KOS's: the connected one, though another is listed first.
  @Test func headSpeaksOfOneKOS() throws {
    let model = home {
      $0.kos = [kos(host: "kos.work.ts.net", link: .offline("KOS is not answering.")), kos("d2", host: "127.0.0.1:4317")]
      $0.screenGranted = true
      $0.inputGranted = true
    }
    #expect(model.headKOS?.id == "d2")
    #expect(model.headKOS?.link == .connected)
    model.kos = [kos(host: "kos.work.ts.net", link: .offline("KOS is not answering.")), kos("d2", host: "127.0.0.1:4317", link: .disconnected)]
    #expect(model.headKOS?.id == "d1")
    _ = try render("home-head-first", HomeView(model: model), height: HomeView.height)
  }

  @Test func homeWhenConnectedAndInUse() throws {
    let model = home {
      $0.kos = [kos()]
      $0.screenGranted = true
      $0.inputGranted = true
      $0.session = SessionSummary(
        task: "Export the deck from Keynote as a PDF", requester: "Design", chat: URL(string: "http://127.0.0.1:4417/#/chats/c1"),
        until: Date().addingTimeInterval(900), paused: false)
    }
    _ = try render("home-in-use", HomeView(model: model), height: HomeView.height)
  }

  @Test func homeWhenOfflineAndMissingAGrant() throws {
    let model = home {
      $0.kos = [kos(host: "kos.example.ts.net", link: .offline("KOS is not answering."), askFirst: false)]
      $0.inputGranted = true
      $0.asked = [.screen]
    }
    _ = try render("home-offline", HomeView(model: model), height: HomeView.height)
  }

  @Test func homeWithThePermissionsDrawerOpen() throws {
    let model = home {
      $0.kos = [kos(host: "127.0.0.1:4317")]
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-drawer", HomeView(model: model, permissionsOpen: true), height: HomeView.height)
  }

  @Test func settingsPage() throws {
    let model = home {
      $0.kos = [kos()]
      $0.page = .settings
      $0.longestMinutes = 120
      $0.openAtLogin = .needsApproval
      $0.theme = .light
    }
    _ = try render("settings", HomeView(model: model), height: HomeView.height)
    _ = try render("settings-full", HomeView(model: model), height: 1300)
  }

  @Test func consentWithALengthOfTheOwnersOwn() throws {
    let model = ConsentModel(task: "Tidy the desktop into folders", requester: "Home", offered: [5, 15, 30, 60, 120], longest: 240, timeout: 60)
    model.custom = true
    model.minutes = 45
    _ = try render("consent-custom", ConsentView(model: model))
  }

  @Test func consentNamesTheKOSWhenThereAreSeveral() throws {
    let model = ConsentModel(task: "File the receipts from Downloads", requester: "Expenses", kos: "kos.work.ts.net", offered: [5, 15], timeout: 60)
    _ = try render("consent-kos", ConsentView(model: model))
    #expect(model.kos == "kos.work.ts.net")
  }

  @Test func consentWithAWindowPicker() throws {
    let model = ConsentModel(task: "Export the cover frame", requester: "Design", offered: [5, 15], longest: 60, timeout: 60)
    model.targets = [
      TargetChoice(id: TargetChoice.screen, title: "Entire screen", app: nil, icon: nil),
      TargetChoice(id: "11", title: "Cover", app: "Figma", icon: nil),
      TargetChoice(id: "12", title: "Inbox", app: "Mail", icon: nil),
    ]
    model.target = "11"
    model.suggested = "Figma"
    let size = try render("consent-picker", ConsentView(model: model))
    #expect(size.width == 420)
  }

  @Test func disconnectedByTheOwner() throws {
    let model = home {
      $0.kos = [kos(host: "127.0.0.1:4317", link: .disconnected)]
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-disconnected", HomeView(model: model), height: HomeView.height)
  }

  @Test func pairedWithTwoKOSOneInASession() throws {
    let model = home {
      $0.kos = [kos(host: "127.0.0.1:4317"), kos("d2", host: "kos.work.ts.net", askFirst: false)]
      $0.screenGranted = true
      $0.inputGranted = true
      $0.session = SessionSummary(
        task: "File the receipts from Downloads", requester: "Expenses", kos: "kos.work.ts.net", until: Date().addingTimeInterval(1200),
        paused: false)
    }
    _ = try render("home-two-kos", HomeView(model: model), height: HomeView.height)
    // One open, the other a line, and the hidden apps open: all of it, as it scrolls.
    _ = try render("home-two-kos-open", HomeView(model: model, openKOS: "d2", hiddenOpen: true), height: 1100)
  }

  @Test func addingAnotherKOS() throws {
    let model = home {
      $0.kos = [kos(host: "127.0.0.1:4317")]
      $0.showPairing = true
      $0.address = "https://kos.work.ts.net"
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-adding", HomeView(model: model), height: HomeView.height)
  }

  @Test func theKeychainRefusedThePairings() throws {
    let model = home {
      $0.keychainProblem = "The Keychain would not give KOS for Mac its pairings (User interaction is not allowed.)."
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-keychain", HomeView(model: model), height: HomeView.height)
  }

  @Test func appPicker() throws {
    let apps = [
      AppEntry(id: "com.apple.Safari", name: "Safari", icon: nil, running: true),
      AppEntry(id: "com.apple.mail", name: "Mail", icon: nil, running: true),
      AppEntry(id: "com.apple.Notes", name: "Notes", icon: nil),
      AppEntry(id: "com.figma.Desktop", name: "Figma", icon: nil),
    ]
    let size = try render("picker", AppPicker(apps: apps) { _ in })
    #expect(size.width == 290)
  }

  @Test func sessionBar() throws {
    let model = SessionBarModel(task: "Export the deck from Keynote as a PDF", until: Date().addingTimeInterval(12 * 60))
    _ = try render("bar", SessionBar(model: model))
    model.paused = true
    let size = try render("bar-paused", SessionBar(model: model))
    #expect(size.height == SessionBar.height + 28)
  }

  @Test func sessionBarAtAStepAndWaiting() throws {
    let model = SessionBarModel(task: "Export the deck from Keynote as a PDF", until: Date().addingTimeInterval(12 * 60))
    model.step = "Open the File menu (click)"
    let size = try render("bar-step", SessionBar(model: model))
    model.waiting = true
    #expect(try render("bar-waiting", SessionBar(model: model)) == size)
  }

  /// The menu bar's menu at its head, in each state: every row one height, the head over them.
  @Test func turnMenu() throws {
    let ask = ChatModel.Ask(id: "a1", tool: "computer.act", summary: "Click Submit on the engagement form", chat: "mac:owner")
    let turns: [(String, MenuTurn)] = [
      ("working", MenuTurn(state: .working, step: "Open the Quizzes tab (click)", task: "Fill in the form", session: true)),
      ("working-chat", MenuTurn(state: .working, step: "Thinking")),
      ("waiting", MenuTurn(state: .waiting, step: "Click Submit (click)", task: "Fill in the form", ask: ask, session: true)),
      ("paused", MenuTurn(state: .paused, task: "Fill in the form", kos: "home.local", session: true)),
    ]
    for (name, turn) in turns {
      // On the menu's own ground, which the menu bar draws under it.
      let size = try render("menu-\(name)", TurnMenu(turn: turn, actions: MenuTurnActions()).background(Theme.panel))
      #expect(size.width == TurnMenu.width)
    }
  }

  @Test func consent() throws {
    let model = ConsentModel(
      task: "Open the Figma file from yesterday and export the cover frame", requester: "Design",
      chat: URL(string: "http://127.0.0.1:4417/#/chats/c1"), offered: [5, 15], timeout: 60)
    model.remaining = 44
    let size = try render("consent", ConsentView(model: model))
    #expect(size.width == 380)
  }
}
