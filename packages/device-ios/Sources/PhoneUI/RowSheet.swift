import DeviceKit
import PhoneCore
import SwiftUI

/// A sheet's row the owner tapped, as a sheet of the phone's own, laid out as
/// iOS lays out its settings: the row's name and its tab at the head, then a
/// line for each field, its label at the leading side and its value at the
/// trailing one, figures in tabular digits; a value too long for the line
/// goes under its label. The sheet is as tall as its fields, and scrolls past
/// the screen's height. Each value can be selected to copy.
struct RowSheet: View {
  let row: ArtifactShelf.Row

  var body: some View {
    ScrollView {
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
        ForEach(Array(row.fields.enumerated()), id: \.offset) { i, field in
          FieldLine(field: field)
          if i < row.fields.count - 1 { Hairline().padding(.leading, 20) }
        }
      }
      .padding(.bottom, 12)
      .background(GeometryReader { box in Color.clear.preference(key: FitHeight.self, value: box.size.height) })
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Theme.panel)
  }

  /// One field: its label and value on a line, or the value under the label when the line cannot hold both.
  private struct FieldLine: View {
    let field: ArtifactShelf.Row.Field

    private var value: some View {
      Text(field.value.isEmpty ? "Empty" : field.value)
        .font(field.numeric ? .kos(.body).monospacedDigit() : .kos(.body))
        .foregroundStyle(field.value.isEmpty ? Theme.faint : Theme.text)
        .textSelection(.enabled)
    }

    private var label: some View {
      Text(field.label).font(.kos(.body)).foregroundStyle(Theme.muted)
    }

    var body: some View {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
          label.lineLimit(1).fixedSize()
          Spacer(minLength: 0)
          value.lineLimit(1).fixedSize()
        }
        VStack(alignment: .leading, spacing: 3) {
          label
          value.fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
      }
      .padding(.horizontal, 20)
      .frame(minHeight: 44)
      .accessibilityElement(children: .combine)
    }
  }
}

/// How tall a sheet's content is, so the sheet can stop there rather than at half the screen.
struct FitHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
