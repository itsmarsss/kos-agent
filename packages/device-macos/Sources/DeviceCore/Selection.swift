import Foundation

/// What the chat window reads the owner's selection through: Accessibility, behind a seam so its rules are tested.
///
/// Attribute names are Accessibility's own (AXFocusedUIElement, AXSelectedText). Not tied to the main actor:
/// Accessibility calls are safe on any thread, and a read is made away from the main one so a slow app does not
/// hold the Mac's windows.
public protocol SelectionAccess: AnyObject {
  associatedtype Element: Equatable
  /// Accessibility is allowed for this app: without it nothing can be read.
  var trusted: Bool { get }
  /// False once the app being read has stopped answering, so nothing more is asked of it.
  var answering: Bool { get }
  func application(_ pid: Int32) -> Element
  func element(_ attribute: String, of element: Element) -> Element?
  func string(_ attribute: String, of element: Element) -> String?
  func bool(_ attribute: String, of element: Element) -> Bool?
  /// Whether the app took the value.
  func set(_ attribute: String, _ value: Bool, on element: Element) -> Bool
  /// The words of the element's selected text marker range, which web content holds its selection in.
  func markedText(of element: Element) -> String?
  func children(of element: Element) -> [Element]
}

/// The app a selection is read from.
public struct SelectionApp: Equatable, Sendable {
  public let pid: Int32
  public let bundle: String?
  /// Built on Chromium (an Electron or Chromium Embedded app), so it keeps its tree off until asked.
  public let chromiumBased: Bool

  public init(pid: Int32, bundle: String?, chromiumBased: Bool = false) {
    self.pid = pid
    self.bundle = bundle
    self.chromiumBased = chromiumBased
  }
}

public enum SelectionRead: Equatable, Sendable {
  case text(String)
  /// Nothing selected, or nothing the app would say.
  case nothing
  /// Not read: a hidden app, or a password field.
  case refused
  /// Accessibility is not allowed for this app.
  case untrusted
}

/// The owner's selection in the app beside the chat, read through Accessibility.
///
/// Chromium and Electron apps keep their tree off until asked for it, so in
/// one of those a first read that finds nothing asks (AXManualAccessibility,
/// and for a Chromium browser that does not take it,
/// AXEnhancedUserInterface), reads once more, and turns it off again. The
/// selection is the focused element's, else one of its parents' (a web area
/// around a focused link), as text or as a marker range, else the first in
/// the focused window, looked for within a bound and a time budget. Never a
/// hidden app's, a password field's, or while secure input is on.
///
/// Not tied to an actor: each reader is used from one serial queue.
public final class SelectionReader<Access: SelectionAccess>: @unchecked Sendable {
  public static var limit: Int { 4_000 }
  /// How far up from the focused element, and how many elements of the window, are looked through.
  static var parents: Int { 8 }
  static var walked: Int { 300 }
  /// How long the questions of one read may take in all, the wait for a tree apart.
  static var budget: TimeInterval { 0.15 }

  /// Browsers on Chromium, which answer AXEnhancedUserInterface where AXManualAccessibility is not taken.
  static var chromium: Set<String> {
    [
      "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
      "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi",
      "com.operasoftware.Opera", "company.thebrowser.Browser",
    ]
  }

  static var manual: String { "AXManualAccessibility" }
  static var enhanced: String { "AXEnhancedUserInterface" }

  private let access: Access
  private let now: () -> TimeInterval
  /// When the current read must stop asking.
  private var deadline: TimeInterval = 0
  /// What the last read was of: the app, and the element focused in it then.
  private var last: (pid: Int32, focused: Access.Element?)?

  public init(_ access: Access, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.access = access
    self.now = now
  }

  /// `secureInput` is asked again after the wait; `pause` is the wait for an app to build its tree, blocking this
  /// reader's queue. With `onlyIfChanged`, nil when the app and its focused element are those of the last read, so
  /// one opening of the window reads once however often it is asked.
  public func read(
    _ app: SelectionApp, hidden: Bool, onlyIfChanged: Bool = false, secureInput: () -> Bool, pause: () -> Void
  ) -> SelectionRead? {
    guard !hidden, access.trusted, !secureInput() else {
      last = nil
      return hidden || access.trusted ? .refused : .untrusted
    }
    deadline = now() + Self.budget
    let root = access.application(app.pid)
    let focused = access.element("AXFocusedUIElement", of: root)
    if onlyIfChanged, let last, last.pid == app.pid, last.focused == focused { return nil }
    last = (app.pid, focused)
    if let found = look(in: root, focused: focused) { return found }
    guard access.answering, inTime, opensItsTree(app) else { return .nothing }

    var turnedOn: [String] = []
    if access.bool(Self.manual, of: root) != true, access.set(Self.manual, true, on: root) {
      turnedOn.append(Self.manual)
    } else if app.bundle.map(Self.chromium.contains) == true, access.bool(Self.enhanced, of: root) != true,
              access.set(Self.enhanced, true, on: root) {
      turnedOn.append(Self.enhanced)
    }
    guard !turnedOn.isEmpty else { return .nothing }
    // Off again as it was: an app with its tree on does more work, and some animate their windows differently.
    defer { for flag in turnedOn { _ = access.set(flag, false, on: root) } }
    let paused = now()
    pause()
    deadline += now() - paused
    guard !secureInput() else { return .refused }
    return look(in: root, focused: access.element("AXFocusedUIElement", of: root)) ?? .nothing
  }

  private var inTime: Bool { now() < deadline }

  /// Only an app built on Chromium is asked for its tree: in any other the flags do nothing, or change how it behaves.
  private func opensItsTree(_ app: SelectionApp) -> Bool {
    app.chromiumBased || app.bundle.map(Self.chromium.contains) == true
  }

  /// The selection, a refusal for a password field, or nil for none found.
  private func look(in root: Access.Element, focused: Access.Element?) -> SelectionRead? {
    if let focused {
      if secure(focused) { return .refused }
      var at: Access.Element? = focused
      for _ in 0..<Self.parents {
        guard let element = at, access.answering, inTime else { break }
        if let text = selected(element) { return .text(text) }
        let role = access.string("AXRole", of: element)
        if role == "AXWindow" || role == "AXApplication" { break }
        at = access.element("AXParent", of: element)
      }
    }
    guard access.answering, inTime, let window = access.element("AXFocusedWindow", of: root) else { return nil }
    return walk(window).map { .text($0) }
  }

  /// The first selection in the window, breadth first, password fields passed over.
  private func walk(_ window: Access.Element) -> String? {
    var queue = [window]
    var seen = 0
    while !queue.isEmpty, seen < Self.walked, access.answering, inTime {
      let element = queue.removeFirst()
      seen += 1
      if secure(element) { continue }
      if let text = selected(element) { return text }
      queue.append(contentsOf: access.children(of: element))
    }
    return nil
  }

  private func selected(_ element: Access.Element) -> String? {
    for text in [access.string("AXSelectedText", of: element), access.markedText(of: element)] {
      let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !trimmed.isEmpty { return String(trimmed.prefix(Self.limit)) }
    }
    return nil
  }

  private func secure(_ element: Access.Element) -> Bool {
    let field = "AXSecureTextField"
    return access.string("AXSubrole", of: element) == field || access.string("AXRole", of: element) == field
  }
}

/// The app the chat window speaks of: the one in front, or, while the window itself is, the one the owner was in before.
public struct FrontTracker<App> {
  public private(set) var last: App?
  private let isMine: (App) -> Bool

  public init(isMine: @escaping (App) -> Bool) {
    self.isMine = isMine
  }

  /// An app came to the front: kept, unless it is this one.
  public mutating func note(_ app: App?) {
    if let app, !isMine(app) { last = app }
  }

  /// The app beside the window, given the one in front now.
  public func beside(front: App?) -> App? {
    front.flatMap { isMine($0) ? last : $0 }
  }
}
