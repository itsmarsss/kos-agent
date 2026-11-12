import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// Memory: what KOS knows, pinned first, searched by words and held to a
/// tag, each claim opening to what it replaced and where it came from. Read
/// only: what KOS knows changes in a chat or on the dashboard.
struct MemoryScreen: View {
  @ObservedObject var memory: MemoryModel
  @ObservedObject private var claims: Page<[Routes.Claim]>
  var now: Date = Date()
  @Environment(\.go) private var go
  @Environment(\.dismiss) private var dismiss

  init(memory: MemoryModel, now: Date = Date()) {
    self.memory = memory
    claims = memory.claims
    self.now = now
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Memory", detail: claims.value.map { $0.count == 1 ? "1 thing KOS knows" : "\($0.count) things KOS knows" }, back: { dismiss() })
    } content: {
      Loaded(page: claims, loading: "Reading what KOS knows") { all in
        PageList(refresh: claims.refresh) {
          if let error = claims.error { StaleNote(error: error).pageRow(separator: false) }
          VStack(spacing: 4) {
            SearchField(prompt: "Search what KOS knows", text: $memory.words)
            if !memory.tags.isEmpty {
              FilterChips(options: [(nil, "All")] + memory.tags.prefix(12).map { ($0, $0) }, selected: memory.tag) { memory.tag = $0 }
                .padding(.horizontal, -16)
            }
          }
          .padding(.top, 12)
          .pageRow(separator: false)
          let shown = memory.shown
          if shown.isEmpty {
            PageNote(kind: .empty(
              symbol: "brain", title: all.isEmpty ? "KOS doesn't know anything yet" : "Nothing matches",
              detail: all.isEmpty ? "Tell it something to remember in a chat." : "Try other words, or another tag."))
              .pageRow(separator: false)
          }
          ForEach(shown) { claim in
            Button { go(.claim(key: claim.key)) } label: { ClaimRow(claim: claim, now: now) }.buttonStyle(.plain).pageRow()
          }
        }
      }
    }
    .task { await claims.ensure() }
  }
}

/// One claim: its key, what it says, and whether it is pinned, with its tags.
struct ClaimRow: View {
  let claim: Routes.Claim
  let now: Date

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Tile(claim.pinned ? "pin.fill" : claim.kind == "preference" ? "heart" : "lightbulb", tint: claim.pinned ? Theme.warn : Theme.violet)
      VStack(alignment: .leading, spacing: 3) {
        Text(claim.key).font(.kos(.dense, .semibold, design: .monospaced)).foregroundStyle(Theme.text).lineLimit(1)
        Text(claim.value).font(.kos(.body)).foregroundStyle(Theme.text).lineLimit(2)
        Text(([ChatTime.relative(claim.updatedAt.at, now: now)] + claim.tags.map { "#\($0)" }).joined(separator: " · "))
          .font(.kos(.tiny)).foregroundStyle(Theme.faint).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Image(systemName: "chevron.right").font(.kos(.detail, .semibold)).foregroundStyle(Theme.faint).padding(.top, 4)
    }
    .padding(.vertical, 10)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// One claim, all of it: what it says, how far it is trusted and who wrote it, its tags, what it replaced, and the
/// words it was drawn from.
struct ClaimScreen: View {
  let key: String
  @ObservedObject var memory: MemoryModel
  @ObservedObject private var trace: Page<Routes.Trace>
  var now: Date = Date()
  @Environment(\.dismiss) private var dismiss

  init(key: String, memory: MemoryModel, now: Date = Date()) {
    self.key = key
    self.memory = memory
    trace = memory.trace(key)
    self.now = now
  }

  var body: some View {
    let claim = memory.claims.value?.first { $0.key == key }
    PageFrame {
      PageHead(title: key, detail: claim.map { ClaimWords.kind($0) }, back: { dismiss() })
    } content: {
      PageList(refresh: trace.refresh) {
        if let claim {
          Text(claim.value).font(.kos(.body)).foregroundStyle(Theme.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 14)
            .pageRow(separator: false)
          GroupHead(title: "About it").pageRow(separator: false)
          fact("Trusted as", ClaimWords.trust(claim.trust))
          fact("Known to", claim.scope == "global" ? "Every chat" : claim.scope)
          if let source = claim.source { fact("Written by", source) }
          fact("Changed", ChatTime.relative(claim.updatedAt.at, now: now))
          if !claim.tags.isEmpty { fact("Tags", claim.tags.map { "#\($0)" }.joined(separator: " ")) }
        }
        if let value = trace.value {
          if !value.before.isEmpty {
            GroupHead(title: "What it replaced", count: value.before.count).pageRow(separator: false)
            ForEach(value.before, id: \.listKey) { old in
              PageRowLabel(symbol: "clock.arrow.circlepath", tint: Theme.muted, title: old.value, detail: ChatTime.relative(old.updatedAt.at, now: now), detailLines: 1).pageRow()
            }
          }
          if !value.evidence.isEmpty {
            GroupHead(title: "Where it came from", count: value.evidence.count).pageRow(separator: false)
            // Keyed apart from the claims above, whose ids are numbers too: a list keys its rows as one.
            ForEach(Array(value.evidence.enumerated()), id: \.offset.evidenceKey) { _, said in
              VStack(alignment: .leading, spacing: 3) {
                Text(said.text).font(.kos(.dense)).foregroundStyle(Theme.text).lineLimit(4)
                Text("\(said.role == "owner" ? "You" : "KOS") · \(ChatTime.relative(said.ts.at, now: now))").font(.kos(.tiny)).foregroundStyle(Theme.faint)
              }
              .padding(.vertical, 10)
              .pageRow()
            }
          }
        } else if let error = trace.error {
          StaleNote(error: error).pageRow(separator: false)
        } else {
          ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 16).pageRow(separator: false)
        }
      }
    }
    .task { await trace.ensure() }
  }

  private func fact(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).font(.kos(.dense)).foregroundStyle(Theme.muted).frame(width: 96, alignment: .leading)
      Text(value).font(.kos(.dense)).foregroundStyle(Theme.text).frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 10)
    .accessibilityElement(children: .combine)
    .pageRow()
  }
}

/// A claim's kind and trust, said plainly.
enum ClaimWords {
  static func kind(_ claim: Routes.Claim) -> String {
    [claim.pinned ? "Pinned" : nil, claim.kind == "preference" ? "A preference" : "A fact"].compactMap { $0 }.joined(separator: " · ")
  }

  static func trust(_ trust: String) -> String {
    switch trust {
    case "owner": "You said it"
    case "agent": "KOS worked it out"
    case "tool": "A tool gave it"
    default: "Another program wrote it"
    }
  }
}

private extension Routes.Claim {
  var listKey: String { "claim-\(id)" }
}

private extension Int {
  var evidenceKey: String { "evidence-\(self)" }
}
