import DeviceCore
import SwiftUI

/// The owner's settings for this Mac, behind the gear: how long KOS may stay,
/// how long the prompt waits, what pauses KOS and how it moves, how the app
/// starts and what it says, and its log.
///
/// Kept here, on the Mac, on purpose: nothing KOS sends can change them, and
/// where they are stricter than what KOS asks for, they win.
struct SettingsPage: View {
  @ObservedObject var model: HomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        IconButton(symbol: "chevron.left", label: "Back") { model.page = .home }
        Text("Settings").font(.kos(.title, .semibold)).foregroundStyle(Theme.text)
        Spacer()
      }
      .padding(.top, 2)
      KOSSection("Sessions") {
        Card {
          setting("Longest session", "KOS may ask for longer; it gets this at most. +15 min on the bar adds time while it works.") {
            KOSChoices(model.longestChoices.map { ($0, minutesWords($0)) }, selected: model.longestMinutes, choose: model.actions.setLongest)
          }
          Hairline()
          setting("Wait for an answer", "Then the prompt says no by itself, so a Mac nobody is at says no.") {
            KOSChoices(model.promptWaitChoices.map { ($0, seconds($0)) }, selected: model.promptWaitSeconds, choose: model.actions.setPromptWait)
          }
          Hairline()
          setting("End when idle for", "A session KOS has stopped using gives the Mac back on its own.") {
            KOSChoices(model.idleChoices.map { ($0, minutesWords($0)) }, selected: model.idleMinutes, choose: model.actions.setIdle)
          }
        }
      }
      KOSSection("While KOS works") {
        Card {
          setting("What takes over from KOS", takeoverDetail) {
            KOSChoices(Takeover.allCases.map { ($0, $0.label) }, selected: model.takeover, choose: model.actions.setTakeover)
          }
          Hairline()
          setting("KOS's pointer", model.pace == .shown
            ? "Glides from place to place, so you can follow where it goes."
            : "Gets where it is going in under a third of the time.") {
            KOSChoices(Pace.allCases.map { ($0, $0.label) }, selected: model.pace, choose: model.actions.setPace)
          }
        }
      }
      KOSSection("App") {
        Card {
          setting("Theme", themeDetail) {
            KOSChoices(ThemeChoice.allCases.map { ($0, $0.label) }, selected: model.theme, choose: model.actions.setTheme)
          }
          Hairline()
          SwitchRow("Open at login", loginDetail, isOn: model.openAtLogin != .off, set: model.actions.setOpenAtLogin)
          if model.openAtLogin == .needsApproval {
            HStack(spacing: 6) {
              Text("macOS wants you to allow it first.").font(.kos(.small)).foregroundStyle(Theme.warn)
              Button("Login Items", action: model.actions.openLoginItems).buttonStyle(KOSButtonStyle(.ghost))
            }
          }
          Hairline()
          SwitchRow(
            "Connect when it opens",
            model.connectWhenOpened ? "KOS can reach this Mac as soon as KOS for Mac is running." : "Off: it waits for Connect, so KOS cannot reach this Mac until you say.",
            isOn: model.connectWhenOpened, set: model.actions.setConnectWhenOpened)
          Hairline()
          SwitchRow(
            "Sounds",
            model.sounds ? "A chime when KOS asks, when a session starts without asking, and when one ends." : "Off: the border and the bar are the only signs.",
            isOn: model.sounds, set: model.actions.setSounds)
          Hairline()
          SwitchRow(
            "Time left in the menu bar", "Beside the KOS for Mac icon, while a session runs.",
            isOn: model.timeInMenuBar, set: model.actions.setTimeInMenuBar)
        }
      }
      KOSSection("Diagnostics") {
        Card {
          HStack(alignment: .top, spacing: 12) {
            RowText("Log", "The line to each KOS and every session, since KOS for Mac opened. Tasks are kept out. Copy it to send when something went wrong.")
            Spacer(minLength: 8)
            Button(model.logCopied ? "Copied" : "Copy log", action: model.actions.copyLog).buttonStyle(KOSButtonStyle(.secondary))
          }
        }
      }
    }
  }

  private var takeoverDetail: String {
    switch model.takeover {
    case .anyMove: return "Any touch of the pointer, a scroll, a click or a key takes over at once."
    case .deliberate: return "A real move of the pointer, a click or a key. A nudge or a scroll does not."
    case .clicksAndKeys: return "Only a click or a key. Move the pointer and scroll freely while KOS works."
    }
  }

  private func setting<Control: View>(_ title: String, _ detail: String, @ViewBuilder control: () -> Control) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      RowText(title, detail)
      control()
    }
  }

  private var themeDetail: String {
    switch model.theme {
    case .dashboard: return "Light or dark as KOS's dashboard is set, so the two look alike."
    case .light, .dark: return "This app's own, whatever the dashboard is set to."
    case .system: return "Follows macOS, light by day and dark at night if it is set to Auto."
    }
  }

  private var loginDetail: String {
    switch model.openAtLogin {
    case .on: return "KOS for Mac starts with your Mac."
    case .needsApproval: return "On, once macOS has your OK."
    case .off: return "Off: open it yourself when KOS should reach this Mac."
    }
  }

  private func seconds(_ s: Int) -> String {
    s < 60 ? "\(s) s" : minutesWords(s / 60)
  }
}
