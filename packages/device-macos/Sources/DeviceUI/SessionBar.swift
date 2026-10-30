import SwiftUI

/// The bar at the top of the screen while KOS has this Mac: who, for what,
/// and the two buttons that matter.
@MainActor
public final class SessionBarModel: ObservableObject {
  @Published public var task: String
  @Published public var paused = false
  public var pause: () -> Void = {}
  public var resume: () -> Void = {}
  public var stop: () -> Void = {}

  public init(task: String) {
    self.task = task
  }
}

public struct SessionBar: View {
  @ObservedObject private var model: SessionBarModel
  @State private var beat = false

  public static let height: CGFloat = 48

  public init(model: SessionBarModel) {
    self.model = model
  }

  private var tone: Color { model.paused ? Theme.warn : Theme.accent }

  public var body: some View {
    HStack(spacing: 12) {
      ZStack(alignment: .bottomTrailing) {
        KOSFace(size: 26)
        Circle()
          .fill(tone)
          .frame(width: 8, height: 8)
          .overlay(Circle().strokeBorder(Theme.panel, lineWidth: 1.5))
          .opacity(model.paused ? 1 : (beat ? 0.35 : 1))
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(model.paused ? "Paused. You have control." : "KOS is using this Mac")
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(Theme.text)
        Text(model.task)
          .font(.system(size: 11))
          .foregroundStyle(Theme.muted)
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(maxWidth: 300, alignment: .leading)
      }
      Spacer(minLength: 4)
      Button(model.paused ? "Resume" : "Pause", action: model.paused ? model.resume : model.pause)
        .buttonStyle(KOSButtonStyle(.secondary))
        // As wide as "Resume", so the bar keeps its size when it pauses.
        .frame(minWidth: 76)
      Button("Stop", action: model.stop).buttonStyle(KOSButtonStyle(.danger))
    }
    .padding(.leading, 12)
    .padding(.trailing, 8)
    .frame(height: Self.height)
    .background(Theme.panel.opacity(0.96), in: Capsule())
    .overlay(Capsule().strokeBorder(tone.opacity(0.55)))
    .shadow(color: tone.opacity(0.35), radius: 12)
    .padding(14)
    .environment(\.colorScheme, .dark)
    .onAppear {
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { beat = true }
    }
  }
}
