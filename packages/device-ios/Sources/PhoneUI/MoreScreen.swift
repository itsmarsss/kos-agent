import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// More: the rest of the dashboard's pages, under the address of the KOS
/// this phone is paired with. The overview first, since it is the glance; then
/// runs, blobs, files and memory, in the dashboard's order; then this
/// phone's own settings. Above them, quietly, a newer build of this app when
/// KOS has one, which opens the settings' steps to run it.
struct MoreScreen: View {
  @ObservedObject var phone: Phone
  @ObservedObject private var glance: GlanceModel
  @Environment(\.go) private var go

  init(phone: Phone) {
    self.phone = phone
    glance = phone.glance
  }

  private var pages: [(place: Place, symbol: String, tint: Color, title: String, detail: String)] {
    [
      (.overview, "waveform.path.ecg", glance.alarming ? Theme.danger : Theme.accent, "Overview", glance.summary),
      (.runs, "clock.arrow.circlepath", Theme.violet, "Runs", "Schedules, to run now or pause, and every run"),
      (.blobs, "circle.hexagongrid.fill", Theme.violet, "Blobs", "The helpers that keep things up for you"),
      (.files, "folder", Theme.accent, "Files", "Your workspace, read only"),
      (.memory, "brain", Theme.violet, "Memory", "What KOS knows"),
      (.settings, "gearshape", Theme.muted, "Settings", "Speak replies, notifications, and this iPhone's pairing"),
    ]
  }

  var body: some View {
    PageFrame {
      PageHead(title: "More", detail: phone.paired.map { "KOS at \((try? $0.kosAddress().display) ?? $0.address)" } ?? "The rest of KOS")
    } content: {
      PageList(refresh: { glance.ask() }) {
        Color.clear.frame(height: 6).pageRow(separator: false)
        if phone.updateReady {
          Button { go(.settings) } label: {
            PageRowLabel(symbol: "arrow.down.circle", tint: Theme.accent, title: "An update is ready", detail: "Run this app again from Xcode", opens: true)
          }
          .buttonStyle(.plain)
          .pageRow()
        }
        ForEach(pages, id: \.title) { page in
          Button { go(page.place) } label: {
            PageRowLabel(symbol: page.symbol, tint: page.tint, title: page.title, detail: page.detail, opens: true)
          }
          .buttonStyle(.plain)
          .pageRow()
        }
      }
    }
  }
}

/// The little there is to set on the phone: speak replies, KOS's asks on the lock screen, and which KOS it is
/// paired with, to unpair; and the steps to a newer build, when KOS has one.
struct SettingsScreen: View {
  @ObservedObject var phone: Phone
  @ObservedObject var reader: ReplyReader
  @State private var confirming = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    PageFrame {
      PageHead(title: "Settings", back: { dismiss() })
    } content: {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if phone.updateReady {
            UpdateCard(build: phone.update?.build)
          }
          Card {
            SwitchRow("Speak replies", "Read KOS's answers aloud as they land.", isOn: reader.on) { reader.on = $0 }
          }
          NotificationsCard(push: phone.push)
          KOSSection("Paired with") {
            Card {
              RowText(phone.paired?.name ?? "iPhone", phone.paired.map { "KOS at \((try? $0.kosAddress().display) ?? $0.address)" }, size: .body, detailLines: 2)
            }
          }
          if confirming {
            Card(tone: Theme.danger) {
              RowText("Unpair this iPhone?", "KOS forgets it, and it forgets KOS. Pairing again needs a new code.", size: .control)
              HStack(spacing: 10) {
                Button("Keep it") { confirming = false }.buttonStyle(KOSButtonStyle(.secondary, large: true))
                Button("Unpair") { phone.unpair() }.buttonStyle(KOSButtonStyle(.danger, large: true))
              }
            }
          } else {
            Button("Unpair this iPhone") { confirming = true }.buttonStyle(KOSButtonStyle(.danger, large: true))
          }
        }
        .padding(16)
      }
    }
  }
}

/// KOS's asks on the lock screen: where it stands, and the one thing to press. The owner's leave is asked from
/// here, never at launch; once refused, only the iPhone's own Settings can give it back.
struct NotificationsCard: View {
  @ObservedObject var push: PushModel
  @Environment(\.openURL) private var openURL

  private var words: (title: String, detail: String) {
    guard push.available else {
      return ("Notifications", "This build has no push. Once your Apple developer account is set up, build it with push on (README, Push).")
    }
    switch push.permission {
    case .allowed where push.token != nil:
      return ("Asks come to the lock screen", "Deny there as it is; Approve once this iPhone is unlocked. A tap opens the ask.")
    case .allowed:
      return ("Asks come to the lock screen", push.problem.map { "Apple gave no token yet: \($0)" } ?? "Getting this iPhone's token from Apple.")
    case .denied:
      return ("Notifications are off", "Turn them on for KOS in the iPhone's Settings, under Notifications.")
    case .undecided, nil:
      return ("Notifications", "KOS's asks on the lock screen, to approve or deny without opening the app.")
    }
  }

  var body: some View {
    Card {
      RowText(words.title, words.detail, setting: true)
      if push.available, push.permission == .undecided {
        Button("Turn on notifications") { Task { await push.turnOn() } }.buttonStyle(KOSButtonStyle(.secondary, large: true))
      }
      #if os(iOS)
        if push.available, push.permission == .denied, let settings = URL(string: UIApplication.openNotificationSettingsURLString) {
          Button("Open Settings") { openURL(settings) }.buttonStyle(KOSButtonStyle(.secondary, large: true))
        }
      #endif
    }
  }
}

/// KOS has a newer build of this app. An iPhone app cannot update itself (Apple), so it says how to run the new
/// one from Xcode, which KOS cannot do for the owner.
struct UpdateCard: View {
  let build: Build?

  private static let steps = [
    "On your Mac, open the KOS project in Xcode.",
    "Pick this iPhone as where it runs: plugged in, or on the same Wi-Fi.",
    "Press Run. The app opens again on the new build.",
  ]

  var body: some View {
    Card {
      HStack(alignment: .top, spacing: 12) {
        Tile("arrow.down.circle", tint: Theme.accent)
        RowText("An update is ready", "KOS has a newer build of this app\(build.map { ", \($0.short)" } ?? ""). An iPhone app updates only from Xcode.", size: .body)
      }
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(Self.steps.enumerated()), id: \.offset) { n, step in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n + 1)").font(.kos(.small, .semibold)).foregroundStyle(Theme.muted).frame(width: 12, alignment: .leading)
            Text(step).font(.kos(.small)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(.leading, 44)
      .accessibilityElement(children: .combine)
    }
  }
}
