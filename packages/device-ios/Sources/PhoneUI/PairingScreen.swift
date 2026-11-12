import DeviceKit
import PhoneCore
import SwiftUI

/// Pairing with a KOS on the home Wi-Fi: the link KOS shows, or its address
/// and code; then, for an address typed by hand, the certificate's words to
/// compare with the dashboard's before the code goes.
struct PairingScreen: View {
  @ObservedObject var flow: PairingFlow
  let problem: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        VStack(spacing: 12) {
          KOSFace(size: 88, mood: flow.step == .enter ? .asleep : .working)
          Text("Pair with KOS").font(.kos(.title, .semibold))
          Text("KOS for iPhone talks to your KOS over your home Wi-Fi.")
            .font(.kos(.dense))
            .foregroundStyle(Theme.muted)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 32)

        switch flow.step {
        case .confirm(let check): confirm(check)
        default: enter
        }
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 24)
    }
    .scrollDismissesKeyboard(.interactively)
  }

  private var enter: some View {
    VStack(alignment: .leading, spacing: 16) {
      Card(tone: Theme.accent, wash: true, padding: EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)) {
        Text("On the dashboard: Settings, Devices. Turn on Phones on this Wi-Fi, then Add a device. Paste its link here, or type its address and code.")
          .font(.kos(.detail))
          .foregroundStyle(Theme.text)
          .fixedSize(horizontal: false, vertical: true)
      }
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text("Link or address").font(.kos(.small, .medium)).foregroundStyle(Theme.muted)
          Spacer()
          PasteButton(payloadType: String.self) { strings in
            if let text = strings.first { flow.address = text }
          }
          .labelStyle(.titleOnly)
          .buttonBorderShape(.capsule)
          .controlSize(.small)
          .tint(Theme.accent)
        }
        Entry(label: "Link or address", placeholder: "192.168.1.20:4319", text: $flow.address, kind: .address)
      }
      VStack(alignment: .leading, spacing: 5) {
        Text("Code").font(.kos(.small, .medium)).foregroundStyle(Theme.muted)
        Entry(label: "Code", placeholder: "K7QX-M2PA", text: $flow.code, kind: .code)
      }
      VStack(alignment: .leading, spacing: 5) {
        Text("This iPhone is called").font(.kos(.small, .medium)).foregroundStyle(Theme.muted)
        Entry(label: "This iPhone is called", placeholder: "iPhone", text: $flow.name, kind: .name)
      }
      if let error = flow.error ?? problem {
        Text(error).font(.kos(.detail)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
      }
      Button {
        Task { await flow.next() }
      } label: {
        HStack(spacing: 8) {
          if flow.step != .enter { ProgressView().controlSize(.small).tint(Theme.onAccent) }
          Text(flow.step == .checking ? "Checking KOS…" : flow.step == .pairing ? "Pairing…" : "Continue")
        }
      }
      .buttonStyle(KOSButtonStyle(.primary, large: true))
      .disabled(!flow.canContinue)
    }
  }

  private func confirm(_ check: PairingFlow.Check) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      KOSSection("Check the words") {
        Card(padding: 16, spacing: 12) {
          Text("KOS at \(check.link.address.display) shows this certificate:")
            .font(.kos(.dense))
            .fixedSize(horizontal: false, vertical: true)
          Text(check.words)
            .font(.kos(.title, .semibold, design: .monospaced))
            .tracking(1.5)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
            .accessibilityLabel("Certificate words: \(check.words.map { String($0) }.joined(separator: " "))")
          Text("Settings, Devices shows its words under Phones on this Wi-Fi. If they differ, something else is answering: do not pair.")
            .font(.kos(.detail))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack(spacing: 10) {
        Button("Cancel") { flow.back() }.buttonStyle(KOSButtonStyle(.secondary, large: true))
        Button("They match") { Task { await flow.confirm() } }.buttonStyle(KOSButtonStyle(.primary, large: true))
      }
    }
  }
}

/// A field on the page's well, as the kit's KOSField, sized for a thumb, with the keyboard each field wants.
private struct Entry: View {
  enum Kind { case address, code, name }

  let label: String
  let placeholder: String
  @Binding var text: String
  let kind: Kind

  var body: some View {
    // The placeholder drawn under the field, as the composer's is: a prompt takes the field's own colour.
    TextField("", text: $text)
      .textFieldStyle(.plain)
      .font(.kos(.body, design: kind == .code ? .monospaced : .default))
      .foregroundStyle(Theme.text)
      .overlay(alignment: .leading) {
        if text.isEmpty {
          Text(placeholder).font(.kos(.body, design: kind == .code ? .monospaced : .default)).foregroundStyle(Theme.faint).allowsHitTesting(false)
        }
      }
      .accessibilityLabel(label)
      .autocorrectionDisabled(kind != .name)
      #if os(iOS)
      .textInputAutocapitalization(kind == .code ? .characters : kind == .name ? .words : .never)
      .keyboardType(kind == .address ? .URL : .asciiCapable)
      #endif
      .padding(.horizontal, 12)
      .frame(minHeight: 48)
      .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous).strokeBorder(Theme.line))
  }
}
