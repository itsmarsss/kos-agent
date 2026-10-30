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

  /// `permissionsOpen` starts the drawer open, as a window opened to manage them would.
  public init(model: HomeModel, permissionsOpen: Bool = false) {
    self.model = model
    _permissionsOpen = State(initialValue: permissionsOpen)
  }

  /// What changes the layout, so one animation carries every change, wherever it came from.
  private struct Layout: Equatable {
    let page: HomePage
    let pairing: Bool
    let session: Bool
    let allGranted: Bool
    let permissionsOpen: Bool
    let needsRestart: Bool
    let link: LinkState
  }

  private var layout: Layout {
    Layout(
      page: model.page, pairing: model.pairing, session: model.session != nil, allGranted: model.allGranted,
      permissionsOpen: permissionsOpen, needsRestart: model.needsRestart, link: model.link)
  }

  static let motion = Animation.spring(response: 0.36, dampingFraction: 0.88)

  public var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        WindowControls(close: model.actions.close, minimize: model.actions.minimize)
        Spacer()
        if model.page == .home {
          IconButton(symbol: "gearshape", label: "Settings") { model.page = .settings }
            .transition(.opacity)
        }
      }
      ZStack(alignment: .top) {
        if model.page == .home {
          home.transition(.asymmetric(insertion: .move(edge: .leading), removal: .move(edge: .leading)).combined(with: .opacity))
        } else {
          SettingsPage(model: model).transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .trailing)).combined(with: .opacity))
        }
      }
    }
    .padding(.horizontal, Theme.gutter)
    .padding(.top, 15)
    .padding(.bottom, Theme.gutter)
    .frame(width: 460)
    .fixedSize(horizontal: false, vertical: true)
    .background(GeometryReader { geo in Color.clear.preference(key: HeightKey.self, value: geo.size.height) })
    .onPreferenceChange(HeightKey.self) { height in MainActor.assumeIsolated { model.contentHeight = height } }
    .animation(Self.motion, value: layout)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Theme.bg)
    .ignoresSafeArea()
    .environment(\.colorScheme, .dark)
  }

  private var home: some View {
    VStack(alignment: .leading, spacing: 14) {
      header.padding(.top, 2)
      if let session = model.session {
        sessionCard(session).transition(.opacity.combined(with: .move(edge: .top)))
      }
      section("KOS") {
        ZStack(alignment: .top) {
          if model.pairing {
            pairingCard.transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
          } else {
            connectionCard.transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
          }
        }
      }
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
    switch model.link {
    case .offline, .untrusted, .outdated: return .error
    case .disconnected: return .asleep
    default: return .idle
    }
  }

  private var linkPill: Pill {
    switch model.link {
    case .notPaired: return Pill("Not paired", tone: .muted, dot: true)
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

  private var pairingCard: some View {
    Card {
      Text("Pair with your KOS").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("From KOS: Settings, Devices, Add a device. Open its link or paste it here.")
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
        if model.showPairing && model.link != .notPaired {
          Button("Cancel") { model.showPairing = false }.buttonStyle(KOSButtonStyle(.ghost))
        }
        Button("Pair", action: model.actions.pair)
          .buttonStyle(KOSButtonStyle(.primary))
          .keyboardShortcut(.defaultAction)
          .disabled(model.busy || model.address.isEmpty || model.code.isEmpty)
      }
    }
  }

  private var connectionCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 3) {
        Text(connectionTitle).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
        Text(connectionDetail).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      if let host = model.host {
        HStack(spacing: 6) {
          Image(systemName: "network").font(.system(size: 11)).foregroundStyle(Theme.faint)
          if let dashboard = model.dashboard {
            KOSLink(host, to: dashboard)
          } else {
            Text(host).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
          }
        }
      }
      HStack(spacing: 8) {
        switch model.link {
        case .disconnected:
          Button("Connect", action: model.actions.connect).buttonStyle(KOSButtonStyle(.primary))
        default:
          Button("Disconnect", action: model.actions.disconnect)
            .buttonStyle(KOSButtonStyle(.ghost))
            .help("KOS sees this Mac offline until you connect again; the pairing stays.")
        }
        Spacer()
        switch model.link {
        case .offline, .untrusted, .replaced:
          Button("Reconnect", action: model.actions.reconnect).buttonStyle(KOSButtonStyle(.secondary))
        default:
          EmptyView()
        }
        Button("Pair again") { model.showPairing = true }.buttonStyle(KOSButtonStyle(.ghost))
        Button("Unpair", action: model.actions.unpair).buttonStyle(KOSButtonStyle(.danger))
      }
    }
  }

  private var connectionTitle: String {
    let name = model.deviceName.map { "as \($0)" } ?? ""
    switch model.link {
    case .connected: return "Connected to KOS \(name)".trimmingCharacters(in: .whitespaces)
    case .connecting: return "Connecting to KOS…"
    case .offline: return "Can't reach KOS"
    case .untrusted: return "This KOS could not prove who it is"
    case .replaced: return "Connected from another copy"
    case .outdated: return "KOS is newer than this app"
    case .disconnected: return "Not connected"
    case .notPaired: return "Not paired"
    }
  }

  private var connectionDetail: String {
    switch model.link {
    case .connected: return "KOS can ask for a session. You decide here."
    case .connecting: return "Dialling out; nothing listens on this Mac."
    case .offline(let why): return why
    case .untrusted: return "Its signature did not match the key from pairing, so nothing it says is acted on."
    case .replaced: return "Another KOS Device with this pairing took the line. Reconnect to take it back."
    case .outdated: return "Update KOS Device to keep using it with this KOS."
    case .disconnected: return "KOS can't reach this Mac until you connect. The pairing stays."
    case .notPaired: return ""
    }
  }

  // MARK: Permissions

  /// Asked for until both are granted; then one line, opening into a drawer to manage them.
  private var permissionsCard: some View {
    Card {
      if model.allGranted {
        DrawerHeader(open: permissionsOpen) { permissionsOpen.toggle() }
      }
      if !model.allGranted || permissionsOpen {
        VStack(alignment: .leading, spacing: 10) {
          if model.allGranted { Divider().overlay(Theme.line) }
          grantRow(.screen)
          Divider().overlay(Theme.line)
          grantRow(.input)
          if model.needsRestart {
            restartNotice.transition(.opacity.combined(with: .move(edge: .top)))
          }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
  }

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

  private var rulesCard: some View {
    Card {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Ask before each session").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
          Text(model.askFirst
            ? "KOS asks here, with the task and how long, every time."
            : "Off: KOS's approval queue decides instead. The border and Stop still show.")
            .font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        KOSSwitch(isOn: model.askFirst, set: model.actions.setAskFirst)
      }
      Divider().overlay(Theme.line)
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text("Hidden from KOS").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
          Spacer()
          AddAppButton(apps: model.pickable) { model.actions.hide($0) }
        }
        Text("Blanked from every picture KOS gets, and closed to its clicks and keys.")
          .font(.system(size: 11.5)).foregroundStyle(Theme.muted)
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

/// The permissions, folded: both on, and a chevron to look closer.
private struct DrawerHeader: View {
  let open: Bool
  let toggle: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 12) {
        Image(systemName: "checkmark.shield")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(Theme.ok)
          .frame(width: 32, height: 32)
          .background(Theme.ok.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text("Screen Recording and Accessibility are on").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
          Text(open ? "Each has a switch in System Settings." : "KOS can use them only in a session you allow.")
            .font(.system(size: 11.5)).foregroundStyle(Theme.muted)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.down")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(hovering ? Theme.text : Theme.faint)
          .rotationEffect(.degrees(open ? 180 : 0))
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(.easeOut(duration: 0.14), value: hovering)
    .animation(HomeView.motion, value: open)
  }
}

private struct HeightKey: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}
