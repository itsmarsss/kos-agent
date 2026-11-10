import DeviceCore
import SwiftUI

/// The owner's settings for this Mac, behind the gear: how long KOS may stay,
/// how long the ask waits, what pauses KOS and how it moves, the theme, how
/// the app starts and what it says, and its log. Laid out as the Chrome
/// popup's settings are, section for section, row for row; what only a Mac
/// has (its pointer, login, sounds) is in the same rows.
///
/// Kept here, on the Mac, on purpose: nothing KOS sends can change them, and
/// where they are stricter than what KOS asks for, they win.
struct SettingsPage: View {
  @ObservedObject var model: HomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      // The popup's .page-head, with no head over it here or there: back, then the title at the name's size.
      HStack(spacing: 10) {
        IconButton(symbol: "chevron.left", label: "Back") { model.page = .home }
        Text("Settings").font(.kos(.body, .semibold)).foregroundStyle(Theme.text)
        Spacer()
      }
      .padding(.top, 2)
      KOSSection("Sessions") {
        Card {
          setting("Longest session", "KOS may ask for longer; it gets this at most. +15 min on the bar adds time while it works.") {
            KOSChoices(model.longestChoices.map { ($0, minutesWords($0)) }, selected: model.longestMinutes, choose: model.actions.setLongest)
          }
          Hairline()
          setting("Wait for an answer", "Then the ask says no by itself, so a Mac nobody is at says no.") {
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
          setting("What pauses KOS", takeoverDetail) {
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
      KOSSection("Appearance") {
        Card {
          setting("Theme", themeDetail) {
            KOSChoices(ThemeChoice.allCases.map { ($0, $0.label) }, selected: model.theme, choose: model.actions.setTheme)
          }
        }
      }
      KOSSection("App") {
        Card {
          SwitchRow("Open at login", loginDetail, isOn: model.openAtLogin != .off, set: model.actions.setOpenAtLogin)
          if model.openAtLogin == .needsApproval {
            HStack(spacing: 8) {
              Text("macOS wants you to allow it first.").font(.kos(.small)).foregroundStyle(Theme.warn)
              Spacer(minLength: 8)
              Button("Login Items", action: model.actions.openLoginItems).buttonStyle(KOSButtonStyle(.secondary, small: true))
            }
          }
          Hairline()
          SwitchRow(
            "Connect when KOS for Mac opens",
            model.connectWhenOpened ? "Each KOS can reach this Mac as soon as it opens." : "Off: each waits for Connect, so KOS cannot reach this Mac until you say.",
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
            RowText("Log", "Each KOS's line and every session, since KOS for Mac opened. Tasks are kept out. Copy it to send when something went wrong.", setting: true)
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
      RowText(title, detail, setting: true)
      control()
    }
  }

  private var themeDetail: String {
    switch model.theme {
    case .dashboard: return "As the dashboard looks, once KOS has said it; until then, follows this Mac's appearance."
    case .light: return "Light here, whatever the dashboard is set to."
    case .dark: return "Dark here, whatever the dashboard is set to."
    case .system: return "This Mac's own: follows this computer's appearance."
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
