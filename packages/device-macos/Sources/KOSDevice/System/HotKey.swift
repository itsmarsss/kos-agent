import Carbon

/// One key combination that works whichever app is in front: the chat
/// window's, ⌥⌘K. Carbon's hot key, which macOS gives without a permission,
/// where watching every key would need Input Monitoring.
@MainActor
final class HotKey {
  /// ⌥⌘K.
  static let chat = (code: UInt32(kVK_ANSI_K), modifiers: UInt32(cmdKey | optionKey))

  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let pressed: () -> Void

  /// Nothing when macOS will not give the combination, such as one another app holds.
  init?(code: UInt32, modifiers: UInt32, pressed: @escaping () -> Void) {
    self.pressed = pressed
    var kind = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let me = Unmanaged.passUnretained(self).toOpaque()
    let installed = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, data in
        guard let data else { return noErr }
        let key = Unmanaged<HotKey>.fromOpaque(data).takeUnretainedValue()
        // Carbon calls on the main thread.
        MainActor.assumeIsolated { key.pressed() }
        return noErr
      },
      1, &kind, me, &handler)
    guard installed == noErr else { return nil }
    let id = EventHotKeyID(signature: OSType(0x4B4F_5344), id: 1)
    guard RegisterEventHotKey(code, modifiers, id, GetApplicationEventTarget(), 0, &ref) == noErr else { return nil }
  }
}
