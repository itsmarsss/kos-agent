import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// More: the rest of the dashboard's pages, under KOS and the address this
/// phone is paired with. The overview first, since it is the glance; then
/// runs, blobs, files and memory, in the dashboard's order; then this
/// phone's own settings.
struct MoreScreen: View {
  @ObservedObject var phone: Phone
  @ObservedObject private var chat: ChatModel
  @ObservedObject private var glance: GlanceModel
  @Environment(\.go) private var go

  init(phone: Phone) {
    self.phone = phone
    chat = phone.chat
    glance = phone.glance
  }

  private var pages: [(place: Place, symbol: String, tint: Color, title: String, detail: String)] {
    [
      (.overview, "waveform.path.ecg", glance.alarming ? Theme.danger : Theme.accent, "Overview", glance.summary),
      (.runs, "clock.arrow.circlepath", Theme.violet, "Runs", "Schedules, to run now or pause, and every run"),
      (.blobs, "circle.hexagongrid.fill", Theme.violet, "Blobs", "The helpers that keep things up for you"),
      (.files, "folder", Theme.accent, "Files", "Your workspace, read only"),
      (.memory, "brain", Theme.violet, "Memory", "What KOS knows"),
      (.settings, "gearshape", Theme.muted, "Settings", "Speak replies, and this iPhone's pairing"),
    ]
  }

  var body: some View {
    PageFrame {
      HStack(spacing: 10) {
        KOSFace(size: 36, mood: chat.online ? .idle : BlobMood(link: chat.link), look: chat.face)
        RowText(phone.paired?.name ?? "KOS", phone.paired.map { (try? $0.kosAddress().display) ?? $0.address }, size: .title, titleLines: 1, detailLines: 1)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 6)
    } content: {
      PageList(refresh: { glance.ask() }) {
        Color.clear.frame(height: 6).pageRow(separator: false)
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

/// The little there is to set on the phone: speak replies, and which KOS it is paired with, to unpair.
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
          Card {
            SwitchRow("Speak replies", "Read KOS's answers aloud as they land.", isOn: reader.on) { reader.on = $0 }
          }
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
