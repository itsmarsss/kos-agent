import DeviceKit
import PhoneCore
import SwiftUI

/// A sheet's row the owner tapped, as a sheet of the phone's own: the row's
/// name and its tab at the head, then every field on a line of its own, its
/// label over its value, figures in tabular digits. Each value can be
/// selected to copy.
struct RowSheet: View {
  let row: ArtifactShelf.Row

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title).font(.kos(.title, .semibold)).lineLimit(2)
        if !row.sheet.isEmpty { Text(row.sheet).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 20)
      .padding(.top, 24)
      .padding(.bottom, 12)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      Hairline()
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(row.fields.enumerated()), id: \.offset) { i, field in
            VStack(alignment: .leading, spacing: 3) {
              Text(field.label).font(.kos(.small, .medium)).foregroundStyle(Theme.muted)
              Text(field.value.isEmpty ? "Empty" : field.value)
                .font(field.numeric ? .kos(.body).monospacedDigit() : .kos(.body))
                .foregroundStyle(field.value.isEmpty ? Theme.faint : Theme.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .accessibilityElement(children: .combine)
            if i < row.fields.count - 1 { Hairline().padding(.leading, 20) }
          }
        }
      }
      .contentMargins(.bottom, 16, for: .scrollContent)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Theme.panel)
  }
}
