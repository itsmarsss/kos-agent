import AppKit
import SwiftUI

/// KOS Device's one window: where it stands with KOS, what macOS lets it do,
/// and the owner's own rules for this Mac.
///
/// Three windows (pairing, permissions, hidden apps) became one, so the
/// owner sees the whole state in a glance and never hunts the menu for it.
/// The model holds what is shown; the app fills it and does what the actions
/// say. Nothing here reaches the system.

public enum LinkState: Equatable {
  case notPaired
  case connecting
  case connected
  case offline(String)
  /// The far end could not sign with the key pinned at pairing.
  case untrusted
  /// Another copy of KOS Device took the line.
  case replaced
  case outdated
}

public enum Grant: CaseIterable {
  case screen, input
}

public struct AppEntry: Identifiable, Equatable {
  public let id: String
  public let name: String
  public let icon: NSImage?
  /// On this Mac now. A hidden app that is not stays hidden, should it arrive.
  public let installed: Bool

  public init(id: String, name: String, icon: NSImage?, installed: Bool = true) {
    self.id = id
    self.name = name
    self.icon = icon
    self.installed = installed
  }
}

public struct SessionSummary: Equatable {
  public let task: String
  public let requester: String
  public let until: Date
  public let paused: Bool

  public init(task: String, requester: String, until: Date, paused: Bool) {
    self.task = task
    self.requester = requester
    self.until = until
    self.paused = paused
  }
}

public struct HomeActions {
  public var pair: () -> Void = {}
  public var unpair: () -> Void = {}
  public var reconnect: () -> Void = {}
  public var grant: (Grant) -> Void = { _ in }
  public var setAskFirst: (Bool) -> Void = { _ in }
  public var hide: (String) -> Void = { _ in }
  public var unhide: (String) -> Void = { _ in }
  public var pause: () -> Void = {}
  public var resume: () -> Void = {}
  public var stop: () -> Void = {}

  public init() {}
}

@MainActor
public final class HomeModel: ObservableObject {
  @Published public var link: LinkState = .notPaired
  /// KOS's address as the owner reads it, once paired.
  @Published public var host: String?
  /// This Mac's name in KOS, once paired.
  @Published public var deviceName: String?
  @Published public var session: SessionSummary?
  @Published public var screenGranted = false
  @Published public var inputGranted = false
  /// A grant asked for once: the next press goes to its switch in System Settings.
  @Published public var asked: Set<Grant> = []
  @Published public var askFirst = true
  @Published public var hidden: [AppEntry] = []
  /// Running apps that could be hidden.
  @Published public var addable: [AppEntry] = []

  // The pairing form.
  @Published public var showPairing = false
  @Published public var address = ""
  @Published public var code = ""
  @Published public var name = ""
  @Published public var note = ""
  @Published public var noteFailed = false
  @Published public var busy = false

  public var actions = HomeActions()

  public init() {}

  public func granted(_ grant: Grant) -> Bool {
    grant == .screen ? screenGranted : inputGranted
  }
}

public struct HomeView: View {
  @ObservedObject private var model: HomeModel

  public init(model: HomeModel) {
    self.model = model
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      header
      if let session = model.session { sessionCard(session) }
      VStack(alignment: .leading, spacing: 8) {
        SectionLabel("KOS")
        if model.link == .notPaired || model.showPairing { pairingCard } else { connectionCard }
      }
      VStack(alignment: .leading, spacing: 8) {
        SectionLabel("Permissions")
        permissionsCard
      }
      VStack(alignment: .leading, spacing: 8) {
        SectionLabel("On this Mac")
        rulesCard
      }
    }
    .padding(Theme.gutter)
    .padding(.top, 8)
    .frame(width: 460)
    .background(Theme.bg)
    .environment(\.colorScheme, .dark)
  }

  // MARK: Header

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      KOSFace(size: 42)
      VStack(alignment: .leading, spacing: 2) {
        Text("KOS Device").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
        Text("Only in sessions you allow.").font(.system(size: 12)).foregroundStyle(Theme.muted)
      }
      Spacer(minLength: 8)
      linkPill
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
      Text("“\(session.task)”, asked from \(session.requester)").font(.system(size: 12.5)).foregroundStyle(Theme.muted).lineLimit(2)
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
      Text("From KOS: Settings, Devices, Add a device. Open its link or paste it here.")
        .font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
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
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 3) {
          Text(connectionTitle).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
          Text(connectionDetail).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
      }
      if let host = model.host {
        HStack(spacing: 6) {
          Image(systemName: "network").font(.system(size: 11)).foregroundStyle(Theme.faint)
          Text(host).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
        }
      }
      HStack(spacing: 8) {
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
    case .notPaired: return ""
    }
  }

  // MARK: Permissions

  private var permissionsCard: some View {
    Card {
      grantRow(.screen, icon: "rectangle.dashed.badge.record", title: "Screen Recording", detail: "Shows KOS the screen it is working on.")
      Divider().overlay(Theme.line)
      grantRow(.input, icon: "cursorarrow.click.2", title: "Accessibility", detail: "Moves the pointer and types, and notices when you take over.")
    }
  }

  private func grantRow(_ grant: Grant, icon: String, title: String, detail: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: icon)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(model.granted(grant) ? Theme.ok : Theme.accent)
        .frame(width: 32, height: 32)
        .background((model.granted(grant) ? Theme.ok : Theme.accent).opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
        Text(detail).font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      if model.granted(grant) {
        Pill("Granted", tone: .ok)
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
          addMenu
        }
        Text("Blanked from every picture KOS gets, and closed to its clicks and keys.")
          .font(.system(size: 11.5)).foregroundStyle(Theme.muted)
        FlowRow(spacing: 6) {
          ForEach(model.hidden.filter(\.installed)) { app in chip(app) }
        }
        let absent = model.hidden.filter { !$0.installed }.map(\.name)
        if !absent.isEmpty {
          Text("Also hidden if installed: \(absent.joined(separator: ", ")).")
            .font(.system(size: 11)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
        }
      }
      Divider().overlay(Theme.line)
      HStack(spacing: 8) {
        Image(systemName: "hand.raised").font(.system(size: 12)).foregroundStyle(Theme.faint)
        Text("Touch the mouse, trackpad or keyboard and KOS pauses at once. It never types into password fields.")
          .font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func chip(_ app: AppEntry) -> some View {
    HStack(spacing: 5) {
      if let icon = app.icon {
        Image(nsImage: icon).resizable().frame(width: 14, height: 14)
      } else {
        Image(systemName: "app.dashed").font(.system(size: 11)).foregroundStyle(Theme.faint)
      }
      Text(app.name).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
      Button {
        model.actions.unhide(app.id)
      } label: {
        Image(systemName: "xmark").font(.system(size: 8.5, weight: .bold)).foregroundStyle(Theme.faint)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop hiding \(app.name)")
    }
    .padding(.leading, 7)
    .padding(.trailing, 8)
    .padding(.vertical, 4)
    .background(Theme.panel2, in: Capsule())
    .overlay(Capsule().strokeBorder(Theme.line))
  }

  private var addMenu: some View {
    Menu {
      if model.addable.isEmpty { Text("No other apps are open") }
      ForEach(model.addable) { app in
        Button(app.name) { model.actions.hide(app.id) }
      }
    } label: {
      Label("Add app", systemImage: "plus").font(.system(size: 12, weight: .semibold))
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .tint(Theme.accent)
    .foregroundStyle(Theme.accent)
  }
}

/// Lays its children in rows, wrapping when a row is full: chips of app names.
struct FlowRow: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    arrange(subviews, width: proposal.width ?? .infinity).size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (index, point) in arrange(subviews, width: bounds.width).points.enumerated() {
      subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
    }
  }

  private func arrange(_ subviews: Subviews, width: CGFloat) -> (points: [CGPoint], size: CGSize) {
    var points: [CGPoint] = []
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        x = 0
        y += rowHeight + spacing
        rowHeight = 0
      }
      points.append(CGPoint(x: x, y: y))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      widest = max(widest, x - spacing)
    }
    return (points, CGSize(width: widest, height: y + rowHeight))
  }
}
