import SwiftUI

/// Close and minimise, in KOS's colours, where the system's lights would be.
///
/// Like the system's, they show what they do only under the pointer, and go
/// grey while the window is not in front. The window cannot be resized, so
/// there is no third.
public struct WindowControls: View {
  private let close: () -> Void
  private let minimize: () -> Void
  @State private var hovering = false
  @Environment(\.controlActiveState) private var active

  public init(close: @escaping () -> Void, minimize: @escaping () -> Void) {
    self.close = close
    self.minimize = minimize
  }

  public var body: some View {
    HStack(spacing: 8) {
      light(Theme.danger, symbol: "xmark", label: "Close", action: close)
        .keyboardShortcut("w", modifiers: .command)
      light(Theme.warn, symbol: "minus", label: "Minimise", action: minimize)
        .keyboardShortcut("m", modifiers: .command)
    }
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }

  private func light(_ colour: Color, symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Circle()
        .fill(active == .inactive && !hovering ? Theme.lineStrong : colour)
        .frame(width: 12, height: 12)
        .overlay(Circle().strokeBorder(Color.black.opacity(0.18), lineWidth: 0.5))
        .overlay(
          Image(systemName: symbol)
            .font(.system(size: 7, weight: .black))
            .foregroundStyle(Color.black.opacity(0.6))
            .opacity(hovering ? 1 : 0))
        .contentShape(Circle().inset(by: -3))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}
