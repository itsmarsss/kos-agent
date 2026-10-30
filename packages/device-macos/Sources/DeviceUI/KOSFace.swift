import SwiftUI

/// KOS's face, the same blob the dashboard draws for KOS (packages/shared
/// face.ts, seed "kos"): its body and two upright eyes on a 100 by 100 grid.
/// It blinks now and then, so the app reads as someone rather than a form.
public struct KOSFace: View {
  private let size: CGFloat
  private let blinks: Bool
  @State private var shut = false

  public init(size: CGFloat = 40, blinks: Bool = true) {
    self.size = size
    self.blinks = blinks
  }

  public var body: some View {
    ZStack {
      Outline().fill(Color(hex: 0x3585ED))
      Eye(x: 41.62, shut: shut).fill(Color(hex: 0x141D29))
      Eye(x: 58.38, shut: shut).fill(Color(hex: 0x141D29))
    }
    .frame(width: size, height: size)
    .task {
      guard blinks else { return }
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: UInt64.random(in: 2_800_000_000...5_200_000_000))
        withAnimation(.easeIn(duration: 0.07)) { shut = true }
        try? await Task.sleep(nanoseconds: 110_000_000)
        withAnimation(.easeOut(duration: 0.12)) { shut = false }
      }
    }
    .accessibilityHidden(true)
  }

  /// The body's outline, as face.ts smooths it for KOS.
  private struct Outline: Shape {
    func path(in rect: CGRect) -> Path {
      let s = rect.width / 100
      func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
      var path = Path()
      path.move(to: p(89.90, 52.00))
      let curves: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
        (90.06, 56.85, 89.57, 62.06, 87.85, 66.54), (86.14, 71.02, 83.21, 75.44, 79.61, 78.87),
        (76.01, 82.30, 71.19, 85.25, 66.26, 87.11), (61.32, 88.96, 55.42, 90.00, 50.00, 90.00),
        (44.58, 90.00, 38.68, 88.96, 33.74, 87.11), (28.81, 85.25, 23.99, 82.30, 20.39, 78.87),
        (16.79, 75.44, 13.86, 71.02, 12.15, 66.54), (10.43, 62.06, 9.94, 56.85, 10.10, 52.00),
        (10.26, 47.15, 11.19, 41.94, 13.14, 37.46), (15.08, 32.98, 18.19, 28.56, 21.79, 25.13),
        (25.39, 21.70, 30.03, 18.75, 34.73, 16.89), (39.43, 15.04, 44.91, 14.00, 50.00, 14.00),
        (55.09, 14.00, 60.57, 15.04, 65.27, 16.89), (69.97, 18.75, 74.61, 21.70, 78.21, 25.13),
        (81.81, 28.56, 84.92, 32.98, 86.86, 37.46), (88.81, 41.94, 89.74, 47.15, 89.90, 52.00),
      ]
      for c in curves { path.addCurve(to: p(c.4, c.5), control1: p(c.0, c.1), control2: p(c.2, c.3)) }
      path.closeSubpath()
      return path
    }
  }

  /// One eye, a rounded bar 5.4 by 9.6 centred at (x, 48); shut, a line.
  private struct Eye: Shape {
    let x: CGFloat
    var shut: Bool
    var animatableData: CGFloat {
      get { shut ? 1 : 0 }
      set { shut = newValue > 0.5 }
    }

    func path(in rect: CGRect) -> Path {
      let s = rect.width / 100
      let height: CGFloat = shut ? 1.4 : 9.6
      let eye = CGRect(x: rect.minX + (x - 2.7) * s, y: rect.minY + (48 - height / 2) * s, width: 5.4 * s, height: height * s)
      return Path(roundedRect: eye, cornerRadius: min(eye.width, eye.height) / 2)
    }
  }
}
