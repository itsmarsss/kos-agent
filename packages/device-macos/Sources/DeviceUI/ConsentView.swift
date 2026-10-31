import AppKit
import SwiftUI

/// One thing the owner can hand KOS: the whole screen, or a window of one app.
public struct TargetChoice: Identifiable, Equatable {
  public static let screen = "screen"

  public let id: String
  /// The window's title, or "Entire screen".
  public let title: String
  /// The app the window is of; nothing for the screen.
  public let app: String?
  public let icon: NSImage?
  public var thumbnail: NSImage?

  public init(id: String, title: String, app: String?, icon: NSImage?, thumbnail: NSImage? = nil) {
    self.id = id
    self.title = title
    self.app = app
    self.icon = icon
    self.thumbnail = thumbnail
  }
}

/// The owner's yes or no to a session: who asks, for what, for how long.
///
/// The one moment KOS Device interrupts, so it says plainly what allowing
/// means, and it counts down to no rather than waiting on a Mac nobody is at.

@MainActor
public final class ConsentModel: ObservableObject {
  public let task: String
  public let requester: String
  /// Which KOS asks, when this Mac is paired with more than one.
  public let kos: String?
  /// The chat asking, on the dashboard, to read before allowing.
  public let chat: URL?
  /// Whole minutes the owner may choose from, longest last.
  public let offered: [Int]
  /// The most a custom length may be: the owner's longest session.
  public let longest: Int
  public let timeout: Int
  @Published public var minutes: Int
  /// A length of the owner's own, set with the stepper.
  @Published public var custom = false
  @Published public var remaining: Int
  /// The screen and the windows the owner can hand KOS, and the one chosen.
  @Published public var targets: [TargetChoice] = []
  @Published public var target = TargetChoice.screen
  /// The app KOS asked to work in, when it said.
  public var suggested: String?
  public var allow: (Int, String) -> Void = { _, _ in }
  public var deny: () -> Void = {}

  var chosen: TargetChoice? { targets.first { $0.id == target } }

  public init(task: String, requester: String, kos: String? = nil, chat: URL? = nil, offered: [Int], longest: Int? = nil, timeout: Int) {
    self.task = task
    self.requester = requester
    self.kos = kos
    self.chat = chat
    self.offered = offered
    self.longest = max(1, longest ?? offered.last ?? 60)
    self.timeout = timeout
    minutes = offered.last ?? 5
    remaining = timeout
  }
}

public struct ConsentView: View {
  @ObservedObject private var model: ConsentModel
  @State private var glow = false

  public init(model: ConsentModel) {
    self.model = model
  }

  public var body: some View {
    VStack(spacing: 16) {
      ZStack {
        Circle()
          .fill(Theme.accent.opacity(glow ? 0.22 : 0.08))
          .frame(width: 84, height: 84)
          .blur(radius: 10)
        KOSFace(size: 54, mood: .needsYou)
      }
      .padding(.top, 6)
      .onAppear {
        withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { glow = true }
      }

      VStack(spacing: 5) {
        Text("KOS wants to use this Mac").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
        HStack(spacing: 4) {
          Text("Asked from").foregroundStyle(Theme.muted).font(.system(size: 12.5))
          if let chat = model.chat {
            KOSLink(model.requester, to: chat, size: 12.5)
          } else {
            Text(model.requester).foregroundStyle(Theme.accent).fontWeight(.medium).font(.system(size: 12.5))
          }
          if let kos = model.kos {
            Text("on \(kos)").foregroundStyle(Theme.muted).font(.system(size: 12.5)).lineLimit(1).truncationMode(.middle)
          }
        }
      }

      Text(model.task)
        .font(.system(size: 13.5))
        .foregroundStyle(Theme.text)
        .multilineTextAlignment(.leading)
        .lineLimit(5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.accent.opacity(0.3)))

      VStack(alignment: .leading, spacing: 7) {
        Text("For").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.muted)
        FlowRow(spacing: 6) {
          ForEach(model.offered, id: \.self) { minutes in
            Button(minutesWords(minutes)) {
              model.custom = false
              model.minutes = minutes
            }
            .buttonStyle(ChipStyle(selected: !model.custom && model.minutes == minutes))
          }
          Button("Custom") { model.custom = true }
            .buttonStyle(ChipStyle(selected: model.custom))
        }
        if model.custom {
          MinutesStepper(minutes: $model.minutes, longest: model.longest)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .animation(.spring(response: 0.32, dampingFraction: 0.88), value: model.custom)

      if model.targets.count > 1 { TargetPicker(model: model) }

      Text(model.target == TargetChoice.screen
        ? "It will see this screen and use the mouse and keyboard. Touch either to pause it. It never types into password fields or sees the apps you hid."
        : "It will see only this window and act only in it, bringing it to the front first. Touch the mouse or keyboard to pause it.")
        .font(.system(size: 11.5))
        .foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)

      VStack(spacing: 8) {
        HStack(spacing: 8) {
          Button("Deny", action: model.deny)
            .buttonStyle(KOSButtonStyle(.secondary))
            .keyboardShortcut(.cancelAction)
          Spacer()
          Button(allowLabel) { model.allow(model.minutes, model.target) }
            .buttonStyle(KOSButtonStyle(.primary))
            .keyboardShortcut(.defaultAction)
        }
        GeometryReader { geo in
          ZStack(alignment: .leading) {
            Capsule().fill(Theme.line)
            Capsule()
              .fill(Theme.faint)
              .frame(width: geo.size.width * CGFloat(model.remaining) / CGFloat(max(model.timeout, 1)))
              .animation(.linear(duration: 1), value: model.remaining)
          }
        }
        .frame(height: 3)
        Text("Says no by itself in \(model.remaining) s")
          .font(.system(size: 10.5))
          .foregroundStyle(Theme.faint)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
    }
    .padding(22)
    .frame(width: model.targets.count > 1 ? 420 : 380)
    .background(Theme.bg)
    .environment(\.colorScheme, .dark)
  }
}

extension ConsentView {
  var allowLabel: String {
    if let app = model.chosen?.app { return "Allow \(app) for \(minutesWords(model.minutes))" }
    return "Allow for \(minutesWords(model.minutes))"
  }
}

/// What to share, as a screen-sharing picker asks it: the whole screen, or one window, each as it looks now.
struct TargetPicker: View {
  @ObservedObject var model: ConsentModel

  private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 4) {
        Text("Share").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.muted)
        if let app = model.suggested {
          Text("· KOS asked for \(app)").font(.system(size: 11.5)).foregroundStyle(Theme.faint)
        }
      }
      ScrollView {
        LazyVGrid(columns: columns, spacing: 8) {
          ForEach(model.targets) { choice in
            TargetTile(choice: choice, selected: choice.id == model.target) { model.target = choice.id }
          }
        }
        .padding(1)
      }
      .frame(maxHeight: 236)
    }
  }
}

/// One window, or the screen: its picture, its app's icon and its title; lit when chosen.
private struct TargetTile: View {
  let choice: TargetChoice
  let selected: Bool
  let choose: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: choose) {
      VStack(alignment: .leading, spacing: 6) {
        ZStack {
          RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Theme.bg)
          if let picture = choice.thumbnail {
            Image(nsImage: picture).resizable().aspectRatio(contentMode: .fit).padding(4)
          } else {
            Image(systemName: choice.app == nil ? "display" : "macwindow").font(.system(size: 20)).foregroundStyle(Theme.faint)
          }
        }
        .frame(height: 92)
        HStack(spacing: 5) {
          if let icon = choice.icon {
            Image(nsImage: icon).resizable().frame(width: 14, height: 14)
          } else if choice.app == nil {
            Image(systemName: "display").font(.system(size: 11)).foregroundStyle(Theme.muted)
          }
          Text(choice.app.map { app in choice.title.isEmpty ? app : "\(app): \(choice.title)" } ?? choice.title)
            .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
            .foregroundStyle(selected ? Theme.text : Theme.muted)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
      .padding(6)
      .background(selected ? Theme.accent.opacity(0.12) : hovering ? Theme.panel2 : Theme.panel, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(selected ? Theme.accent.opacity(0.7) : hovering ? Theme.lineStrong : Theme.line, lineWidth: selected ? 1.5 : 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(.easeOut(duration: 0.14), value: hovering)
    .animation(.easeOut(duration: 0.14), value: selected)
    .help(choice.app.map { "\($0): \(choice.title)" } ?? choice.title)
  }
}

/// A length of the owner's own: five minutes a step, one at a time under ten, never past the longest.
struct MinutesStepper: View {
  @Binding var minutes: Int
  let longest: Int

  var body: some View {
    HStack(spacing: 10) {
      step("minus", enabled: minutes > 1) { minutes = max(1, minutes - (minutes <= 10 ? 1 : 5)) }
      Text(minutesWords(minutes))
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(Theme.text)
        .frame(minWidth: 64)
      step("plus", enabled: minutes < longest) { minutes = min(longest, minutes + (minutes < 10 ? 1 : 5)) }
      Text("up to \(minutesWords(longest))").font(.system(size: 11)).foregroundStyle(Theme.faint)
    }
  }

  private func step(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 11, weight: .bold))
    }
    .buttonStyle(KOSButtonStyle(.secondary))
    .disabled(!enabled)
  }
}
