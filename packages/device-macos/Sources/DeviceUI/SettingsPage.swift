import SwiftUI

/// The owner's settings for this Mac, behind the gear: how long KOS may stay,
/// how long the prompt waits, and how the app starts.
///
/// Kept here, on the Mac, on purpose: nothing KOS sends can change them, and
/// where they are stricter than what KOS asks for, they win.
struct SettingsPage: View {
  @ObservedObject var model: HomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        IconButton(symbol: "chevron.left", label: "Back") { model.page = .home }
        Text("Settings").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
        Spacer()
      }
      .padding(.top, 2)
      section("Sessions") {
        Card {
          setting("Longest session", "KOS may ask for longer; it gets this at most. +15 min on the bar adds time while it works.") {
            KOSChoices(model.longestChoices.map { ($0, minutesWords($0)) }, selected: model.longestMinutes, choose: model.actions.setLongest)
          }
          Divider().overlay(Theme.line)
          setting("Wait for an answer", "Then the prompt says no by itself, so a Mac nobody is at says no.") {
            KOSChoices(model.promptWaitChoices.map { ($0, seconds($0)) }, selected: model.promptWaitSeconds, choose: model.actions.setPromptWait)
          }
          Divider().overlay(Theme.line)
          setting("End when idle for", "A session KOS has stopped using gives the Mac back on its own.") {
            KOSChoices(model.idleChoices.map { ($0, minutesWords($0)) }, selected: model.idleMinutes, choose: model.actions.setIdle)
          }
        }
      }
      section("App") {
        Card {
          toggle("Open at login", loginDetail, isOn: model.openAtLogin != .off, set: model.actions.setOpenAtLogin)
          if model.openAtLogin == .needsApproval {
            HStack(spacing: 6) {
              Text("macOS wants you to allow it first.").font(.system(size: 11.5)).foregroundStyle(Theme.warn)
              Button("Login Items", action: model.actions.openLoginItems).buttonStyle(KOSButtonStyle(.ghost))
            }
          }
          Divider().overlay(Theme.line)
          toggle(
            "Connect when it opens",
            model.connectWhenOpened ? "KOS can reach this Mac as soon as KOS Device is running." : "Off: it waits for Connect, so KOS cannot reach this Mac until you say.",
            isOn: model.connectWhenOpened, set: model.actions.setConnectWhenOpened)
        }
      }
    }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel(title)
      content()
    }
  }

  private func setting<Control: View>(_ title: String, _ detail: String, @ViewBuilder control: () -> Control) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
        Text(detail).font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      control()
    }
  }

  private func toggle(_ title: String, _ detail: String, isOn: Bool, set: @escaping (Bool) -> Void) -> some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
        Text(detail).font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      KOSSwitch(isOn: isOn, set: set)
    }
  }

  private var loginDetail: String {
    switch model.openAtLogin {
    case .on: return "KOS Device starts with your Mac."
    case .needsApproval: return "On, once macOS has your OK."
    case .off: return "Off: open it yourself when KOS should reach this Mac."
    }
  }

  private func seconds(_ s: Int) -> String {
    s < 60 ? "\(s) s" : minutesWords(s / 60)
  }
}

/// A round button holding one symbol: the gear, the way back, close and minimise.
struct IconButton: View {
  let symbol: String
  let label: String
  /// The colour it takes under the pointer, for one that does something final, like Close.
  var tint: Color?
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(hovering ? (tint ?? Theme.text) : Theme.muted)
        .frame(width: 26, height: 26)
        .background(hovering ? (tint?.opacity(0.14) ?? Theme.panel2) : .clear, in: Circle())
        .overlay(Circle().strokeBorder(hovering ? (tint?.opacity(0.35) ?? Theme.line) : .clear))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(.easeOut(duration: 0.14), value: hovering)
    .accessibilityLabel(label)
    .help(label)
  }
}
