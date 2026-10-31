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
        Image(systemName: icon)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(tint)
          .frame(width: 32, height: 32)
          .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
            .lineLimit(1).truncationMode(.middle)
          Text(detail)
            .font(.system(size: 11.5)).foregroundStyle(Theme.muted)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        trailing()
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
    .accessibilityAddTraits(.isButton)
    .accessibilityValue(open ? "Open" : "Closed")
  }
}

extension DrawerRow where Trailing == EmptyView {
  init(icon: String, tint: Color, title: String, detail: String, open: Bool, toggle: @escaping () -> Void) {
    self.init(icon: icon, tint: tint, title: title, detail: detail, open: open, toggle: toggle) { EmptyView() }
  }
}
