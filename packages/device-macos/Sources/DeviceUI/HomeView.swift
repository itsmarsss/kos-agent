import AppKit
import SwiftUI

/// KOS Device's one window: where it stands with KOS, what macOS lets it do,
/// and the owner's own rules for this Mac.
///
/// Three windows (pairing, permissions, hidden apps) became one, so the
/// owner sees the whole state in a glance. What changes, changes in place:
/// cards cross-fade, the permissions fold away once granted, and the window
/// follows the content's height rather than jumping to it.
public struct HomeView: View {
  @ObservedObject private var model: HomeModel
  /// The permissions drawer, opened by hand once both are granted.
  @State private var permissionsOpen = false
  /// The one KOS whose card is open, by its id: one at a time, so ten KOS are ten lines.
  @State private var openKOS: String?
  @State private var hiddenOpen = false

  /// What starts open, as a window opened to manage one of them would have it.
  public init(model: HomeModel, permissionsOpen: Bool = false, openKOS: String? = nil, hiddenOpen: Bool = false) {
    self.model = model
    _permissionsOpen = State(initialValue: permissionsOpen)
    _openKOS = State(initialValue: openKOS)
    _hiddenOpen = State(initialValue: hiddenOpen)
  }

  /// What changes the layout, so one animation carries every change, wherever it came from.
  private struct Layout: Equatable {
    let page: HomePage
    let pairing: Bool
    let session: Bool
    let allGranted: Bool
    let permissionsOpen: Bool
    let needsRestart: Bool
    let kos: [KOSEntry]
    let keychainProblem: Bool
    let openKOS: String?
    let hiddenOpen: Bool
  }

  private var layout: Layout {
    Layout(
      page: model.page, pairing: model.pairing, session: model.session != nil, allGranted: model.allGranted,
      permissionsOpen: permissionsOpen, needsRestart: model.needsRestart, kos: model.kos,
      keychainProblem: model.keychainProblem != nil, openKOS: openKOS, hiddenOpen: hiddenOpen)
  }

  static let motion = Animation.spring(response: 0.36, dampingFraction: 0.88)
  private static let top = "top"
  private static let pairingForm = "pairing"

  /// The window's one height, whichever page and however many KOS: what one
  /// KOS and nothing else needs. Grown to fit each page, two KOS or the
  /// settings made it taller than a laptop's screen; past this, the page scrolls.
  public static let height: CGFloat = 680

  /// The page's own height, and the height there is to show it in.
  @State private var pageHeight: CGFloat = 0
  @State private var viewHeight: CGFloat = 0

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Stays put while the page under it scrolls.
      controls
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 14)
      ScrollViewReader { scroller in
        ScrollView(.vertical) {
          page
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 14)
            .padding(.bottom, Theme.gutter)
            .frame(width: 460)
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { geo in Color.clear.preference(key: PageHeight.self, value: geo.size.height) })
            .id(Self.top)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(GeometryReader { geo in Color.clear.preference(key: ViewHeight.self, value: geo.size.height) })
        // Settings opens at its top, not wherever the home page was scrolled to.
        .onChange(of: model.page) { scroller.scrollTo(Self.top, anchor: .top) }
        // Add a KOS, or a pairing link opened: the form, wherever it falls on the page.
        .onChange(of: model.showPairing) {
          guard model.showPairing else { return }
          // A turn later: the form is put on the page in this one, and has nowhere to scroll to yet.
          DispatchQueue.main.async { withAnimation(Self.motion) { scroller.scrollTo(Self.pairingForm, anchor: .top) } }
        }
      }
      .overlay(alignment: .bottom) {
        // More below: the page fades out at the foot rather than stopping at an edge.
        // No taller than the page's own margin, so at the very end it covers nothing.
        LinearGradient(colors: [Theme.bg.opacity(0), Theme.bg], startPoint: .top, endPoint: .bottom)
          .frame(height: Theme.gutter)
          .opacity(pageHeight > viewHeight + 1 ? 1 : 0)
          .allowsHitTesting(false)
      }
    }
    .frame(width: 460)
    .onPreferenceChange(PageHeight.self) { height in MainActor.assumeIsolated { pageHeight = height } }
    .onPreferenceChange(ViewHeight.self) { height in MainActor.assumeIsolated { viewHeight = height } }
    .animation(Self.motion, value: layout)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Theme.bg)
    .ignoresSafeArea()
    .environment(\.colorScheme, .dark)
  }

  private var controls: some View {
    // Close and minimise in the gear's own style, not the system's lights
    // or copies of them: round, quiet until the pointer is over them.
    HStack(spacing: 4) {
      IconButton(symbol: "xmark", label: "Close", tint: Theme.danger, action: model.actions.close)
        .keyboardShortcut("w", modifiers: .command)
      IconButton(symbol: "minus", label: "Minimise", action: model.actions.minimize)
        .keyboardShortcut("m", modifiers: .command)
      Spacer()
      if model.page == .home {
        IconButton(symbol: "gearshape", label: "Settings") { model.page = .settings }
          .transition(.opacity)
      }
    }
    .frame(height: 28)
  }

  private var page: some View {
    ZStack(alignment: .top) {
      if model.page == .home {
        home.transition(.asymmetric(insertion: .move(edge: .leading), removal: .move(edge: .leading)).combined(with: .opacity))
      } else {
        SettingsPage(model: model).transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .trailing)).combined(with: .opacity))
      }
    }
  }

  private var home: some View {
    VStack(alignment: .leading, spacing: 14) {
      header.padding(.top, 2)
      if let session = model.session {
        sessionCard(session).transition(.opacity.combined(with: .move(edge: .top)))
      }
      kosSection
      section("Permissions") { permissionsCard }
      section("On this Mac") { rulesCard }
    }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel(title)
      content()
    }
  }

  // MARK: Header

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      KOSFace(size: 42, mood: faceMood)
      VStack(alignment: .leading, spacing: 2) {
        Text("KOS Device").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
        Text("Only in sessions you allow.").font(.system(size: 12)).foregroundStyle(Theme.muted)
      }
      Spacer(minLength: 8)
      linkPill
    }
  }

  /// How KOS looks in the header: at work in a session, sagging when it cannot be reached.
  private var faceMood: BlobMood {
    if let session = model.session { return session.paused ? .idle : .working }
    switch model.overall {
    case .offline, .untrusted, .outdated: return .error
    case .disconnected: return .asleep
    default: return .idle
    }
  }

  private var linkPill: Pill {
    guard let overall = model.overall else { return Pill("Not paired", tone: .muted, dot: true) }
    switch overall {
    case .connecting: return Pill("Connecting", tone: .accent, dot: true)
    case .connected: return Pill(model.session == nil ? "Ready" : "In use", tone: model.session == nil ? .ok : .accent, dot: true)
    case .offline: return Pill("Offline", tone: .warn, dot: true)
    case .untrusted: return Pill("Not KOS", tone: .danger, dot: true)
    case .replaced: return Pill("Elsewhere", tone: .warn, dot: true)
    case .outdated: return Pill("Update", tone: .warn, dot: true)
    case .disconnected: return Pill("Disconnected", tone: .muted, dot: true)
    }
  }

  // MARK: Session

  private func sessionCard(_ session: SessionSummary) -> some View {
    Card {
      HStack(spacing: 10) {
        Circle().fill(session.paused ? Theme.warn : Theme.accent).frame(width: 8, height: 8)
        Text(session.paused ? "Paused: you have control" : "KOS is using this Mac")
          .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
        Spacer()
        Text("until \(session.until.formatted(date: .omitted, time: .shortened))").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
      }
      Text("“\(session.task)”").font(.system(size: 12.5)).foregroundStyle(Theme.text).lineLimit(2)
      HStack(spacing: 4) {
        Text("Asked from").font(.system(size: 12)).foregroundStyle(Theme.muted)
        if let chat = session.chat {
          KOSLink(session.requester, to: chat)
        } else {
          Text(session.requester).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.text)
        }
        if let kos = session.kos {
          Text("on \(kos)").font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
        }
      }
      HStack {
        Spacer()
        if session.paused {
          Button("Resume", action: model.actions.resume).buttonStyle(KOSButtonStyle(.secondary))
        } else {
          Button("Pause", action: model.actions.pause).buttonStyle(KOSButtonStyle(.secondary))
        }
        Button("Stop", action: model.actions.stop).buttonStyle(KOSButtonStyle(.danger))
      }
    }
  }

  // MARK: KOS

  /// Every KOS this Mac is paired with, a card each, and the way to add one.
  ///
  /// Each is its own line, keys and trust: one at home can start sessions
  /// through its approvals while one at work asks here every time. The Mac
  /// has one screen, so while one KOS has a session the others hear it is busy.
  private var kosSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        SectionLabel(model.kos.count > 1 ? "KOS · \(model.kos.count)" : "KOS")
        Spacer()
        if !model.pairing && model.keychainProblem == nil {
          Button {
            model.showPairing = true
          } label: {
            Label("Add a KOS", systemImage: "plus")
          }
          .buttonStyle(KOSButtonStyle(.ghost))
          .help("Pair this Mac with another KOS as well, say one at work beside one at home.")
          .transition(.opacity)
        }
      }
      if let problem = model.keychainProblem {
        keychainCard(problem).transition(.opacity)
      } else {
        ForEach(model.kos) { entry in
          kosCard(entry).transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
        }
        if model.pairing {
          pairingCard.id(Self.pairingForm).transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
        }
      }
    }
  }

  private var pairingCard: some View {
    Card {
      Text(model.kos.isEmpty ? "Pair with your KOS" : "Pair with another KOS")
        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(model.kos.isEmpty
          ? "From KOS: Settings, Devices, Add a device. Open its link or paste it here."
          : "From that KOS: Settings, Devices, Add a device. Pairing one already here replaces it.")
          .font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        if let page = model.devicesPage {
          Spacer(minLength: 4)
          KOSLink("Devices", to: page)
        }
      }
      KOSField("KOS address or pairing link", placeholder: "https://kos.example.ts.net", text: $model.address, mono: true)
      HStack(alignment: .top, spacing: 10) {
        KOSField("Code", placeholder: "K7QX-M2PA", text: $model.code, mono: true).frame(width: 140)
        KOSField("This Mac's name in KOS", placeholder: "MacBook", text: $model.name)
      }
      HStack(spacing: 8) {
        if model.busy { ProgressView().controlSize(.small) }
        Text(model.note)
          .font(.system(size: 11.5))
          .foregroundStyle(model.noteFailed ? Theme.danger : Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        if !model.kos.isEmpty {
          Button("Cancel") { model.showPairing = false }.buttonStyle(KOSButtonStyle(.ghost))
        }
        Button("Pair", action: model.actions.pair)
          .buttonStyle(KOSButtonStyle(.primary))
          .keyboardShortcut(.defaultAction)
          .disabled(model.busy || model.address.isEmpty || model.code.isEmpty)
      }
    }
  }

  /// The pairing is there but the Keychain would not hand it over: a rebuilt app asks again.
  private func keychainCard(_ problem: String) -> some View {
    Card {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "key.slash")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Theme.warn)
          .frame(width: 32, height: 32)
          .background(Theme.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        VStack(alignment: .leading, spacing: 3) {
          Text("Can't read the pairings").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
          Text("\(problem) If macOS asks whether KOS Device may use its Keychain item, choose Always Allow. The pairings are still there.")
            .font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack {
        Spacer()
        Button("Try again", action: model.actions.retryKeychain).buttonStyle(KOSButtonStyle(.primary))
      }
    }
  }

  /// One KOS, folded to a line: which it is and how its line stands. Open,
  /// whether it asks first and what to do with it.
  private func kosCard(_ entry: KOSEntry) -> some View {
    let open = openKOS == entry.id
    return Card {
      DrawerRow(
        icon: "server.rack", tint: tint(entry.link), title: entry.host, detail: summary(entry), open: open,
        toggle: { openKOS = open ? nil : entry.id }
      ) {
        // Connected is the usual state, and the green mark already says it: the pill is for anything else.
        if entry.link != .connected { pill(entry.link) }
      }
      if open {
        VStack(alignment: .leading, spacing: 10) {
          Divider().overlay(Theme.line)
          HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Ask before each session").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
              Text(entry.askFirst
                ? "This KOS asks here, with the task and how long, every time."
                : "Off: this KOS's approval queue decides instead. The border and Stop still show.")
                .font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            KOSSwitch(isOn: entry.askFirst) { model.actions.setAskFirst(entry.id, $0) }
          }
          HStack(spacing: 8) {
            if entry.link == .disconnected {
              Button("Connect") { model.actions.connect(entry.id) }.buttonStyle(KOSButtonStyle(.primary))
            } else {
              Button("Disconnect") { model.actions.disconnect(entry.id) }
                .buttonStyle(KOSButtonStyle(.ghost))
                .help("This KOS sees this Mac offline until you connect again; the pairing stays.")
            }
            Spacer()
            if let dashboard = entry.dashboard {
              KOSLink("Dashboard", to: dashboard)
            }
            switch entry.link {
            case .offline, .untrusted, .replaced:
              Button("Reconnect") { model.actions.reconnect(entry.id) }.buttonStyle(KOSButtonStyle(.secondary))
            default:
              EmptyView()
            }
            Button("Unpair") { model.actions.unpair(entry.id) }.buttonStyle(KOSButtonStyle(.danger))
          }
        }
        .transition(Self.inPlace)
      }
    }
    .clipped()
  }

  private func pill(_ link: LinkState) -> Pill {
    switch link {
    case .connecting: return Pill("Connecting", tone: .accent, dot: true)
    case .connected: return Pill("Connected", tone: .ok, dot: true)
    case .offline: return Pill("Offline", tone: .warn, dot: true)
    case .untrusted: return Pill("Not KOS", tone: .danger, dot: true)
    case .replaced: return Pill("Elsewhere", tone: .warn, dot: true)
    case .outdated: return Pill("Update", tone: .warn, dot: true)
    case .disconnected: return Pill("Disconnected", tone: .muted, dot: true)
    }
  }

  private func tint(_ link: LinkState) -> Color {
    switch link {
    case .connected: return Theme.ok
    case .connecting: return Theme.accent
    case .untrusted: return Theme.danger
    case .disconnected: return Theme.muted
    case .offline, .replaced, .outdated: return Theme.warn
    }
  }

  /// How the line to one KOS stands, in a sentence; connected, whether it asks first, folded away with its switch.
  private func summary(_ entry: KOSEntry) -> String {
    switch entry.link {
    // The pill says connected; the line says as what, and who decides.
    case .connected: return "As \(entry.deviceName) · \(entry.askFirst ? "asks here first" : "its approvals decide")"
    case .connecting: return "Connecting. Dialling out; nothing listens on this Mac."
    case .offline(let why): return "Can't reach it: \(why)"
    case .untrusted: return "It could not sign with the key from pairing, so nothing it says is acted on."
    case .replaced: return "Another KOS Device with this pairing took the line. Reconnect to take it back."
    case .outdated: return "It is newer than this app. Update KOS Device to keep using it."
    case .disconnected: return "Not connected. It can't reach this Mac until you connect; the pairing stays."
    }
  }

  // MARK: Permissions

  /// Asked for until both are granted; then one line, opening into a drawer to manage them.
  ///
  /// What opens fades in where it will sit, and what closes fades where it
  /// was, inside its card: slid, it passed over the rows around it on its
  /// way, and the card's own height is the motion anyway.
  private var permissionsCard: some View {
    Card {
      if model.allGranted {
        DrawerRow(
          icon: "checkmark.shield", tint: Theme.ok, title: "Screen Recording and Accessibility are on",
          detail: permissionsOpen ? "Each has a switch in System Settings." : "KOS can use them only in a session you allow.",
          open: permissionsOpen, toggle: { permissionsOpen.toggle() })
      }
      if !model.allGranted || permissionsOpen {
        VStack(alignment: .leading, spacing: 10) {
          if model.allGranted { Divider().overlay(Theme.line) }
          grantRow(.screen)
          Divider().overlay(Theme.line)
          grantRow(.input)
          if model.needsRestart {
            restartNotice.transition(Self.inPlace)
          }
        }
        .transition(Self.inPlace)
      }
    }
    .clipped()
  }

  /// Appearing after the card has made room, leaving before it closes, never sliding.
  static let inPlace = AnyTransition.asymmetric(
    insertion: .opacity.animation(.easeOut(duration: 0.2).delay(0.1)),
    removal: .opacity.animation(.easeIn(duration: 0.1)))

  private var restartNotice: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.warn)
      Text("Switched Screen Recording on? macOS applies it when KOS Device starts again.")
        .font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      Button("Restart", action: model.actions.restart).buttonStyle(KOSButtonStyle(.secondary))
    }
    .padding(10)
    .background(Theme.warn.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private func grantRow(_ grant: Grant) -> some View {
    let granted = model.granted(grant)
    return HStack(spacing: 12) {
      Image(systemName: grant.icon)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(granted ? Theme.ok : Theme.accent)
        .frame(width: 32, height: 32)
        .background((granted ? Theme.ok : Theme.accent).opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(grant.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
        Text(grant.detail).font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      if granted {
        // Turning one off is as easy as turning it on: its switch, one click away.
        VStack(alignment: .trailing, spacing: 4) {
          Pill("On", tone: .ok)
          KOSLink("System Settings", to: grant.settings, size: 11)
        }
      } else {
        Button(model.asked.contains(grant) ? "Open Settings" : "Grant") { model.actions.grant(grant) }
          .buttonStyle(KOSButtonStyle(.primary))
      }
    }
  }

  // MARK: Rules

  /// The hidden apps in a line: the first few by name, then how many more.
  private var hiddenSummary: String {
    let names = (model.hidden.filter(\.installed) + model.hidden.filter { !$0.installed }).map(\.name)
    switch names.count {
    case 0: return "Nothing yet. Add an app and KOS never sees it."
    case 1: return names[0]
    case 2: return "\(names[0]) and \(names[1])"
    default: return "\(names[0]), \(names[1]) and \(names.count - 2) more"
    }
  }

  private var rulesCard: some View {
    Card {
      DrawerRow(
        icon: "eye.slash", tint: Theme.accent, title: "Hidden from KOS",
        detail: hiddenOpen ? "Blanked from every picture KOS gets, and closed to its clicks and keys." : hiddenSummary,
        open: hiddenOpen, toggle: { hiddenOpen.toggle() })
      if hiddenOpen {
        VStack(alignment: .leading, spacing: 8) {
          FlowRow(spacing: 6) {
            ForEach(model.hidden.filter(\.installed)) { app in
              AppChip(app: app) { model.actions.unhide(app.id) }
            }
          }
          let absent = model.hidden.filter { !$0.installed }.map(\.name)
          if !absent.isEmpty {
            Text("Also hidden if installed: \(absent.joined(separator: ", ")).")
              .font(.system(size: 11)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
          }
          HStack {
            Spacer()
            AddAppButton(apps: model.pickable) { model.actions.hide($0) }
          }
        }
        .transition(Self.inPlace)
      }
      Divider().overlay(Theme.line)
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "hand.raised").font(.system(size: 12)).foregroundStyle(Theme.faint)
        VStack(alignment: .leading, spacing: 6) {
          Text("Touch the mouse, trackpad or keyboard and KOS pauses at once. It never types into password fields.")
            .font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
          KOSLink("How this keeps your Mac safe", to: HomeModel.safety, size: 11.5)
        }
      }
    }
  }
}

private struct PageHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

private struct ViewHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}
