import DeviceKit
import PhoneCore
import SwiftUI

/// Pairing with a KOS on the home Wi-Fi: the link KOS shows, or its address
/// and code; while paired, whether to replace the pairing; then the
/// certificate's words to compare with the dashboard's, or for a KOS with no
/// pin its address to agree to, before the code goes.
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
        case .replace(let entered): replace(entered)
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

  private func replace(_ entered: PairingFlow.Entered) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      KOSSection("Replace the pairing") {
        Card(tone: Theme.warn, wash: true, padding: 16, spacing: 12) {
          Text("Replace the pairing with \(entered.link.address.display)?")
            .font(.kos(.body, .semibold))
            .fixedSize(horizontal: false, vertical: true)
          Text("This iPhone talks to one KOS. Pairing with this one forgets the one it is paired with\(flow.current().map { " at \($0)" } ?? ""), and tells it to forget this iPhone.")
            .font(.kos(.detail))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack(spacing: 10) {
        Button("Cancel") { flow.dismiss() }.buttonStyle(KOSButtonStyle(.secondary, large: true))
        Button("Replace") { Task { await flow.replace() } }.buttonStyle(KOSButtonStyle(.danger, large: true))
      }
    }
  }

  @ViewBuilder
  private func confirm(_ check: PairingFlow.Check) -> some View {
    if let words = check.words {
      compare(check, words: words)
    } else {
      VStack(alignment: .leading, spacing: 16) {
        KOSSection("Pair with this KOS") {
          Card(padding: 16, spacing: 12) {
            Text("Pair with KOS at \(check.link.address.display)?")
              .font(.kos(.body, .semibold))
              .fixedSize(horizontal: false, vertical: true)
            Text("Pair only with a KOS you opened this link from.")
              .font(.kos(.detail))
              .foregroundStyle(Theme.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        HStack(spacing: 10) {
          Button("Cancel") { flow.back() }.buttonStyle(KOSButtonStyle(.secondary, large: true))
          Button("Pair") { Task { await flow.confirm() } }.buttonStyle(KOSButtonStyle(.primary, large: true))
        }
      }
    }
  }

  private func compare(_ check: PairingFlow.Check, words: String) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      KOSSection("Check the words") {
        Card(padding: 16, spacing: 12) {
          Text("KOS at \(check.link.address.display) shows this certificate:")
            .font(.kos(.dense))
            .fixedSize(horizontal: false, vertical: true)
          Text(words)
            .font(.kos(.title, .semibold, design: .monospaced))
            .tracking(1.5)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
            .accessibilityLabel("Certificate words: \(words.map { String($0) }.joined(separator: " "))")
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
