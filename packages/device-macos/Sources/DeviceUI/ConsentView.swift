import SwiftUI

/// The owner's yes or no to a session: who asks, for what, for how long.
///
/// The one moment KOS Device interrupts, so it says plainly what allowing
/// means, and it counts down to no rather than waiting on a Mac nobody is at.

@MainActor
public final class ConsentModel: ObservableObject {
  public let task: String
  public let requester: String
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
  public var allow: (Int) -> Void = { _ in }
  public var deny: () -> Void = {}

  public init(task: String, requester: String, chat: URL? = nil, offered: [Int], longest: Int? = nil, timeout: Int) {
    self.task = task
    self.requester = requester
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

      Text("It will see this screen and use the mouse and keyboard. Touch either to pause it. It never types into password fields or sees the apps you hid.")
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
          Button("Allow for \(minutesWords(model.minutes))") { model.allow(model.minutes) }
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
    .frame(width: 380)
    .background(Theme.bg)
    .environment(\.colorScheme, .dark)
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
