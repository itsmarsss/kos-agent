import AppKit
import SwiftUI

/// Hiding apps from KOS: the chips of those hidden, and a searchable picker for more.

/// A hidden app: lit under the pointer, its cross red, so removing it reads before the click.
struct AppChip: View {
  let app: AppEntry
  let remove: () -> Void
  @State private var hovering = false
  @State private var onCross = false

  var body: some View {
    HStack(spacing: 5) {
      AppIcon(app: app, size: 14)
      Text(app.name).font(.kos(.small, .medium)).foregroundStyle(Theme.text).lineLimit(1)
      Button(action: remove) {
        Image(systemName: "xmark")
          .font(.system(size: 8.5, weight: .bold))
          .foregroundStyle(onCross ? Theme.danger : hovering ? Theme.muted : Theme.faint)
          .frame(width: 14, height: 14)
          .background(onCross ? Theme.danger.opacity(Theme.tint) : .clear, in: Circle())
      }
      .buttonStyle(.plain)
      .onHover { onCross = $0 }
      .pointingHand()
      .accessibilityLabel("Stop hiding \(app.name)")
    }
    .padding(.leading, 7)
    .padding(.trailing, 5)
    .padding(.vertical, 4)
    .background(hovering ? Theme.line.opacity(0.7) : Theme.panel2, in: Capsule())
    .overlay(Capsule().strokeBorder(onCross ? Theme.danger.opacity(Theme.edge) : hovering ? Theme.lineStrong : Theme.line))
    .onHover { hovering = $0 }
    .animation(Theme.hover, value: hovering)
    .animation(Theme.hover, value: onCross)
    .help(app.id)
  }
}

/// "Add app", opening the picker beneath it: the ghost button "Add a KOS" is.
struct AddAppButton: View {
  let apps: [AppEntry]
  let hide: (String) -> Void
  @State private var open = false

  var body: some View {
    Button {
      open.toggle()
    } label: {
      Label("Add app", systemImage: "plus")
    }
    .buttonStyle(KOSButtonStyle(.ghost))
    .popover(isPresented: $open, arrowEdge: .bottom) {
      AppPicker(apps: apps) { id in
        hide(id)
        open = false
      }
    }
  }
}

/// Every app that could be hidden, open ones first, narrowed as you type.
struct AppPicker: View {
  let apps: [AppEntry]
  let choose: (String) -> Void
  @State private var query = ""
  @FocusState private var searching: Bool


  private var shown: [AppEntry] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return apps }
    return apps.filter { $0.name.lowercased().contains(q) || $0.id.lowercased().contains(q) }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").font(.kos(.detail, .medium)).foregroundStyle(Theme.faint)
        TextField("", text: $query, prompt: Text("Search apps").foregroundColor(Theme.faint))
          .textFieldStyle(.plain)
          .font(.kos(.dense))
          .foregroundStyle(Theme.text)
          .focused($searching)
          .onSubmit { if let first = shown.first { choose(first.id) } }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      Hairline()
      if shown.isEmpty {
        Text(apps.isEmpty ? "Every app is hidden already." : "No app called “\(query)”.")
          .font(.kos(.detail))
          .foregroundStyle(Theme.muted)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 18)
      } else {
        ScrollView {
          LazyVStack(spacing: 1) {
            ForEach(shown) { app in
              PickerRow(app: app) { choose(app.id) }
            }
          }
          .padding(5)
        }
        .frame(height: min(CGFloat(shown.count) * (PickerRow.height + 1) + 10, 300))
      }
    }
    .frame(width: 290)
    .background(Theme.panel)
    .environment(\.colorScheme, .dark)
    .onAppear { searching = true }
  }
}

/// One app in the picker: lit in the accent under the pointer, since choosing it hides it, and marked when it is open now.
private struct PickerRow: View {
  let app: AppEntry
  let choose: () -> Void

  var body: some View {
    MenuRow(lit: Theme.accent.opacity(Theme.tint), height: Self.height, action: choose) { hovering in
      HStack(spacing: 9) {
        AppIcon(app: app, size: 20)
        Text(app.name).font(.kos(.control)).foregroundStyle(Theme.text).lineLimit(1)
        Spacer(minLength: 6)
        if app.running {
          Text("Open").font(.kos(.label, .medium)).foregroundStyle(Theme.ok)
        }
        Image(systemName: "eye.slash")
          .font(.kos(.tiny, .medium))
          .foregroundStyle(Theme.accent)
          .opacity(hovering ? 1 : 0)
      }
    }
    .help("Hide \(app.name) from KOS")
  }

  static let height: CGFloat = 32
}

/// An app's own icon, or a dashed stand-in for one not on this Mac.
private struct AppIcon: View {
  let app: AppEntry
  let size: CGFloat

  var body: some View {
    if let icon = app.icon {
      Image(nsImage: icon).resizable().interpolation(.high).frame(width: size, height: size)
    } else {
      Image(systemName: "app.dashed").font(.system(size: size * 0.78)).foregroundStyle(Theme.faint).frame(width: size, height: size)
    }
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
