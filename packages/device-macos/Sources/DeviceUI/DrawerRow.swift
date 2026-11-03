import SwiftUI

/// A row that opens what is under it, for anything the page should show in a
/// line until the owner wants more: each KOS, the permissions, the hidden apps.
///
/// An icon on its tint, a title, a line of detail, whatever the row carries on
/// the right (a state, say), and a chevron that turns when it is open.
struct DrawerRow<Trailing: View>: View {
  let icon: String
  let tint: Color
  let title: String
  let detail: String
  let open: Bool
  let toggle: () -> Void
  @ViewBuilder var trailing: () -> Trailing
  @State private var hovering = false

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 12) {
        Tile(icon, tint: tint)
        RowText(title, detail, titleLines: 1, detailLines: 2, cut: .middle)
        Spacer(minLength: 8)
        trailing()
        Image(systemName: "chevron.down")
          .font(.kos(.tiny, .semibold))
          .foregroundStyle(hovering ? Theme.text : Theme.faint)
          .rotationEffect(.degrees(open ? 180 : 0))
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(Theme.hover, value: hovering)
    .animation(HomeView.motion, value: open)
    .accessibilityAddTraits(.isButton)
    .accessibilityValue(open ? "Open" : "Closed")
  }
}

extension DrawerRow where Trailing == EmptyView {
  init(icon: String, tint: Color, title: String, detail: String, open: Bool, toggle: @escaping () -> Void) {
    self.init(icon: icon, tint: tint, title: title, detail: detail, open: open, toggle: toggle) { EmptyView() }
  }
}
