import AppKit

/// The apps KOS never sees and never acts on, kept by the owner on this Mac.
@MainActor
final class HiddenAppsWindow: NSObject, NSTableViewDataSource, NSTableViewDelegate {
  private let settings: Settings
  private let window = Form.window(title: "Hidden from KOS", width: 420)
  private let table = NSTableView()
  private let add = NSPopUpButton(frame: .zero, pullsDown: true)
  private lazy var remove = NSButton(title: "Remove", target: self, action: #selector(removeSelected))

  init(settings: Settings) {
    self.settings = settings
  }

  func show() {
    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("app"))
    column.width = 360
    if table.tableColumns.isEmpty { table.addTableColumn(column) }
    table.headerView = nil
    table.rowHeight = 22
    table.dataSource = self
    table.delegate = self
    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.widthAnchor.constraint(equalToConstant: 376).isActive = true
    scroll.heightAnchor.constraint(equalToConstant: 180).isActive = true
    add.target = self
    add.action = #selector(addPicked)
    rebuildAddMenu()
    Form.show(window, content: Form.column([
      Form.heading("Apps KOS never sees"),
      Form.note("Their windows are left out of every picture KOS gets, and KOS cannot click or type in them.", width: 376),
      scroll,
      Form.row([add, Form.spacer(), remove]),
    ]))
    table.reloadData()
  }

  func numberOfRows(in tableView: NSTableView) -> Int {
    settings.hiddenApps.count
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    let bundleId = settings.hiddenApps[row]
    let label = NSTextField(labelWithString: "\(Self.name(of: bundleId))  \(bundleId)")
    label.lineBreakMode = .byTruncatingTail
    return label
  }

  @objc private func removeSelected() {
    let index = table.selectedRow
    guard settings.hiddenApps.indices.contains(index) else { return }
    settings.hiddenApps.remove(at: index)
    table.reloadData()
    rebuildAddMenu()
  }

  @objc private func addPicked() {
    guard let bundleId = add.selectedItem?.representedObject as? String else { return }
    settings.hiddenApps.append(bundleId)
    table.reloadData()
    rebuildAddMenu()
  }

  /// The apps running now that are not hidden yet, to pick from.
  private func rebuildAddMenu() {
    add.removeAllItems()
    add.addItem(withTitle: "Add a running app")
    let running = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !settings.isHidden($0.bundleIdentifier) }
      .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
    for app in running {
      let item = NSMenuItem(title: app.localizedName ?? app.bundleIdentifier!, action: nil, keyEquivalent: "")
      item.representedObject = app.bundleIdentifier
      add.menu?.addItem(item)
    }
  }

  private static func name(of bundleId: String) -> String {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return bundleId }
    return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
  }
}
