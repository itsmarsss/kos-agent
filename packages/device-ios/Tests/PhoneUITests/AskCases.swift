import DeviceCore
import DeviceKit
import Foundation

/// The asks a card is drawn for, as the host sends them: the owner's zoom in Google Docs, a shell command, an
/// email, a long typed reply, and a run on the Mac.
enum AskCases {
  static let expires = Date().addingTimeInterval(4 * 60 + 20)
  static let all: [(name: String, ask: ChatModel.Ask)] = [
    ("browser", .init(
      id: "101", tool: "browser.act", title: "Zoom the browser out so more of the document fits per screen",
      args: #"{"intent":"Zoom the browser out so more of the document fits per screen","actions":[{"press":"Meta+Minus"},{"press":"Meta+Minus"},{"press":"Meta+Minus"},{"press":"Meta+Minus"},{"press":"Meta+Home"}]}"#,
      steps: [[.text("Press "), .key("⌘−"), .text(" 4 times, then "), .key("⌘Home")]], place: "In your Chrome on docs.google.com",
      site: "docs.google.com", risk: "Clicks, types or fills on the page", why: "The table is wider than the window; zooming out shows all of it.",
      always: "Always allow on docs.google.com",
      alwaysTip: "Approves this, and from now on clicking, typing and going to pages on docs.google.com in your Chrome stop asking. Running script in the page still asks. Undo it in Settings, Permissions.",
      asker: "Quarterly doc", expires: expires)),
    ("shell", .init(
      id: "102", tool: "shell.run", title: "Run: git push --force-with-lease origin feat/approval-card (in projects/kos)",
      args: #"{"command":"git push --force-with-lease origin feat/approval-card","cwd":"projects/kos"}"#, place: "In projects/kos",
      risk: "Runs a command that may write", always: "Always allow git",
      alwaysTip: "Approves this, and from now on running git on its own stops asking in the project kos. A chain or a pipe still asks. Undo it in Settings, Permissions.",
      asker: "KOS", expires: expires)),
    ("email", .init(
      id: "103", tool: "mcp.gmail.send_email", title: "Email ana@example.com, bo@example.com: “Friday's launch checklist”",
      args: #"{"to":["ana@example.com","bo@example.com"],"subject":"Friday's launch checklist","body":"Hi both,\n\nHere is the checklist for Friday. Each owner confirms their line by Thursday noon, and we meet at nine to go through anything still open. Each owner confirms their line by Thursday noon, and we meet at nine to go through anything still open. Each owner confirms their…"}"#,
      place: "Through gmail", risk: "Sends mail", asker: "Launch", expires: expires)),
    ("typed", .init(
      id: "104", tool: "browser.act", title: "Write the reply to Dana in the comment box",
      args: #"{"intent":"Write the reply to Dana in the comment box","actions":[{"click":"text=Reply"},{"type":{"target":"@e14","text":"Thanks Dana, that works for me. I moved the review to Thursday at 3 so the design team can join."}},{"press":"Meta+Enter"}]}"#,
      steps: [[.text("Click “Reply”")], [.text("Type “Thanks Dana, that works for me. I moved the rev…”")], [.text("Press "), .key("⌘⏎")]],
      place: "In KOS's browser on mail.example.com", site: "mail.example.com", risk: "Clicks, types or fills on the page",
      always: "Always allow on mail.example.com", asker: "Inbox sweep", expires: expires)),
    ("computer", .init(
      id: "105", tool: "computer.act", title: "Save the export and close the dialog",
      args: #"{"intent":"Save the export and close the dialog","actions":[{"action":"left_click","coordinate":[812,440]},{"action":"key","text":"cmd+s"},{"action":"type","text":"Q3 numbers.csv"},{"action":"key","text":"Return"},{"action":"key","text":"Escape"}]}"#,
      steps: [[.text("Click")], [.text("Press "), .key("⌘S")], [.text("Type “Q3 numbers.csv”")], [.text("Press "), .key("⏎"), .text(", then "), .key("Esc")]],
      place: "On your Mac", risk: "Uses your Mac", asker: "Numbers", expires: expires)),
    ("secret", .init(
      id: "106", tool: "http.fetch", title: "HTTP fetch https://api.example.com/v1/invoices",
      args: #"{"url":"https://api.example.com/v1/invoices","headers":{"authorization":"Bearer {{secret:billing_key}}"}}"#,
      place: "On api.example.com", site: "api.example.com", risk: "Sends secret billing_key to api.example.com",
      alwaysNote: "Secrets always ask", asker: "Billing", expires: expires)),
  ]
}
