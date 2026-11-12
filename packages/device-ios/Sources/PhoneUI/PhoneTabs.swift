import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The app once it is paired: five tabs, as an iPhone app keeps them, over
/// the dashboard's pages. Chat is first and opens the app, voice first as it
/// always was; Inbox is next, since deciding what waits is what a phone is
/// reached for most, and it carries the count; Artifacts, to read what KOS
/// made; Projects; and More, which holds the overview (the glance, grown),
/// runs, blobs, files, memory and the phone's own settings. Each tab keeps
/// its place while another is shown; pressing the shown tab again goes back
/// to its top.
public enum PhoneTab: String, CaseIterable, Identifiable, Sendable {
  case chat, inbox, artifacts, projects, more

  public var id: String { rawValue }

  var title: String {
    switch self {
    case .chat: "Chat"
    case .inbox: "Inbox"
    case .artifacts: "Artifacts"
    case .projects: "Projects"
    case .more: "More"
    }
  }

  var symbol: String {
    switch self {
    case .chat: "bubble.left.and.bubble.right"
    case .inbox: "tray"
    case .artifacts: "square.grid.2x2"
    case .projects: "folder"
    case .more: "ellipsis.circle"
    }
  }
}

/// A page under a tab, opened from another: what the tab's stack holds.
enum Place: Hashable {
  case project(slug: String, name: String)
  case blob(String)
  /// A chat's words, read: a project's or a blob's.
  case chat(id: String, title: String)
  case folder(path: String)
  case file(path: String, name: String)
  case claim(key: String)
  case overview, runs, blobs, files, memory, settings
}

/// Opens a page in the tab's stack.
struct GoKey: EnvironmentKey {
  static let defaultValue: (Place) -> Void = { _ in }
}

/// Shows another tab, from a page that points to it (the overview's waiting asks, the chats sheet's artifacts).
struct ShowTabKey: EnvironmentKey {
  static let defaultValue: (PhoneTab) -> Void = { _ in }
}

extension EnvironmentValues {
  var go: (Place) -> Void {
    get { self[GoKey.self] }
    set { self[GoKey.self] = newValue }
  }

  var showTab: (PhoneTab) -> Void {
    get { self[ShowTabKey.self] }
    set { self[ShowTabKey.self] = newValue }
  }
}

/// The tabs and their stacks. A tab is drawn once it is first shown, and kept: going back to one shows it as it was
/// left, and reads nothing until the owner pulls it, but the Inbox, which is read each time it is shown.
struct PhoneHome: View {
  @ObservedObject var phone: Phone
  @ObservedObject private var glance: GlanceModel
  @ObservedObject private var toasts: Toasts
  @ObservedObject private var inbox: InboxModel
  @State private var tab: PhoneTab
  @State private var shown: Set<PhoneTab>
  @State private var paths: [PhoneTab: [Place]] = [:]
  @State private var typing = false

  init(phone: Phone, tab: PhoneTab = .chat) {
    self.phone = phone
    glance = phone.glance
    toasts = phone.board.toasts
    inbox = phone.board.inbox
    _tab = State(initialValue: tab)
    _shown = State(initialValue: [tab])
  }

  /// The count on the Inbox: what the glance last counted, else what the Inbox holds.
  private var waiting: Int {
    glance.report != nil ? glance.waiting : inbox.waiting.value?.approvals.count ?? 0
  }

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        ForEach(PhoneTab.allCases) { each in
          if shown.contains(each) {
            stack(each)
              .opacity(each == tab ? 1 : 0)
              .allowsHitTesting(each == tab)
              .accessibilityHidden(each != tab)
          }
        }
      }
      .overlay(alignment: .bottom) { ToastLine(toasts: toasts) }
      // The keyboard up, the box sits on it: the tabs go until it is put away, as an iPhone's own do.
      if !typing {
        TabBar(selected: tab, badges: [.inbox: waiting, .more: glance.report?.failing.count ?? 0], pick: pick)
      }
    }
    .background(Theme.bg.ignoresSafeArea())
    .environment(\.showTab, pick)
    #if os(iOS)
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in typing = true }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in typing = false }
    #endif
  }

  private func pick(_ next: PhoneTab) {
    if next == tab {
      paths[next] = []
    } else {
      tab = next
      shown.insert(next)
    }
    if next == .inbox { Task { await inbox.refresh() } }
  }

  @ViewBuilder
  private func stack(_ each: PhoneTab) -> some View {
    let path = Binding(get: { paths[each] ?? [] }, set: { paths[each] = $0 })
    NavigationStack(path: path) {
      root(each)
        .navigationDestination(for: Place.self) { place in
          destination(place).hidesNavigationBar()
        }
        .hidesNavigationBar()
    }
    .environment(\.go) { place in paths[each, default: []].append(place) }
  }

  @ViewBuilder
  private func root(_ each: PhoneTab) -> some View {
    switch each {
    case .chat: ChatScreen(phone: phone)
    case .inbox: InboxScreen(inbox: phone.board.inbox)
    case .artifacts: GalleryScreen(gallery: phone.board.gallery, projects: phone.board.projects.list, shelf: phone.artifacts)
    case .projects: ProjectsScreen(projects: phone.board.projects)
    case .more: MoreScreen(phone: phone)
    }
  }

  @ViewBuilder
  private func destination(_ place: Place) -> some View {
    let board = phone.board
    switch place {
    case .project(let slug, let name): ProjectScreen(slug: slug, name: name, page: board.projects.page(slug), runs: board.runs, shelf: phone.artifacts)
    case .blob(let name): BlobScreen(name: name, blobs: board.blobs, gallery: board.gallery, runs: board.runs, shelf: phone.artifacts)
    case .chat(let id, let title): ChatReadScreen(title: title, page: board.blobs.chat(id))
    case .folder(let path): FolderScreen(path: path, page: board.files.folder(path))
    case .file(let path, let name): FileScreen(name: name, page: board.files.file(path))
    case .claim(let key): ClaimScreen(key: key, memory: board.memory)
    case .overview: OverviewScreen(overview: board.overview, glance: phone.glance)
    case .runs: RunsScreen(runs: board.runs)
    case .blobs: BlobsScreen(blobs: board.blobs)
    case .files: FolderScreen(path: ".", page: board.files.folder("."))
    case .memory: MemoryScreen(memory: board.memory)
    case .settings: SettingsScreen(phone: phone, reader: phone.reader)
    }
  }
}

extension View {
  /// The page draws its own head, the chat's height and look; the system's bar would stack a second one over it.
  func hidesNavigationBar() -> some View {
    #if os(iOS)
      toolbar(.hidden, for: .navigationBar)
    #else
      self
    #endif
  }
}

/// The tabs at the foot, over the home indicator: each a symbol and its name, the shown one in the accent, a count
/// on the ones with news.
struct TabBar: View {
  let selected: PhoneTab
  var badges: [PhoneTab: Int] = [:]
  let pick: (PhoneTab) -> Void

  var body: some View {
    HStack(spacing: 0) {
      ForEach(PhoneTab.allCases) { tab in
        let on = tab == selected
        let count = badges[tab] ?? 0
        Button { pick(tab) } label: {
          VStack(spacing: 3) {
            Image(systemName: on ? "\(tab.symbol).fill" : tab.symbol)
              .font(.system(size: 20, weight: .regular))
              .frame(height: 24)
              .overlay(alignment: .topTrailing) {
                if count > 0 {
                  Text(count > 99 ? "99+" : "\(count)")
                    .font(.system(size: 11, weight: .bold).monospacedDigit())
                    .foregroundStyle(Theme.onAccent)
                    .padding(.horizontal, 5)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(tab == .more ? Theme.danger : Theme.warn, in: Capsule())
                    .offset(x: 12, y: -4)
                }
              }
            Text(tab.title).font(.system(size: 10.5, weight: .medium))
          }
          .foregroundStyle(on ? Theme.accent : Theme.muted)
          .frame(maxWidth: .infinity, minHeight: 49)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 0 ? "\(tab.title), \(count) \(tab == .more ? "failing" : "waiting")" : tab.title)
        .accessibilityAddTraits(on ? .isSelected : [])
      }
    }
    .padding(.horizontal, 4)
    .background(Theme.bg.ignoresSafeArea(edges: .bottom))
    .overlay(alignment: .top) { Hairline() }
  }
}

/// What the owner did on a page, said for a moment over the tabs: a run started, a restore done, a decision that did
/// not go.
struct ToastLine: View {
  @ObservedObject var toasts: Toasts
  @Environment(\.accessibilityReduceMotion) private var still

  var body: some View {
    ZStack {
      if let toast = toasts.shown {
        HStack(spacing: 8) {
          Image(systemName: toast.tone == .done ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
            .foregroundStyle(toast.tone == .done ? Theme.ok : Theme.warn)
          Text(toast.words).font(.kos(.dense, .medium)).foregroundStyle(Theme.text).lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Theme.panel2, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.line))
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .onTapGesture { toasts.dismiss() }
        .accessibilityAddTraits(.updatesFrequently)
      }
    }
    .animation(still ? nil : Theme.spring, value: toasts.shown)
  }
}
