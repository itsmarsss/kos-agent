import AppKit
import DeviceCore

/// Pairing: KOS's address and the one-time code from Settings, Devices.
///
/// A pairing link fills both, whether pasted or opened, but never pairs by
/// itself: any web page can open a link, and pairing with a KOS that is not
/// the owner's would let a stranger ask for this Mac. The owner reads the
/// address and presses Pair.
@MainActor
final class PairingWindow: NSObject, NSTextFieldDelegate {
  /// Paired: keep this and dial it.
  var onPaired: ((Pairing) -> Void)?

  private let window = Form.window(title: "Pair with KOS", width: 420)
  private let address = Form.field(placeholder: "https://kos.example.ts.net or http://127.0.0.1:4317", width: 376)
  private let code = Form.field(placeholder: "K7QX-M2PA", width: 160)
  private let name = Form.field(placeholder: "This Mac", width: 376)
  private let status = Form.note("", width: 376)
  private let spinner = NSProgressIndicator()
  private lazy var pairButton = NSButton(title: "Pair", target: self, action: #selector(pair))
  private var current: Pairing?

  func show(prefill link: PairingLink? = nil, replacing current: Pairing?) {
    self.current = current
    address.delegate = self
    if name.stringValue.isEmpty { name.stringValue = Host.current().localizedName ?? "Mac" }
    if let link {
      address.stringValue = link.address.base.absoluteString
      code.stringValue = link.code
      say("Check this is your KOS, then press Pair.")
    } else if let current {
      say("This Mac is paired with \(current.address). Pairing again replaces that.")
    } else {
      say("In KOS, open Settings, Devices, Add a device. Paste the link it shows, or the address and code.")
    }
    pairButton.keyEquivalent = "\r"
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false
    let stack = Form.column([
      Form.heading("Pair this Mac with your KOS"),
      Form.labelled("KOS address or pairing link", address),
      Form.labelled("Code", code),
      Form.labelled("This Mac's name in KOS", name),
      status,
      Form.row([Form.spacer(), spinner, pairButton]),
    ])
    stack.arrangedSubviews.last?.translatesAutoresizingMaskIntoConstraints = false
    stack.arrangedSubviews.last?.widthAnchor.constraint(equalToConstant: 376).isActive = true
    Form.show(window, content: stack)
  }

  /// A pasted pairing link fills the address and the code.
  func controlTextDidChange(_ notification: Notification) {
    guard let link = try? PairingLink.parse(address.stringValue) else { return }
    address.stringValue = link.address.base.absoluteString
    code.stringValue = link.code
    say("Check this is your KOS, then press Pair.")
  }

  @objc private func pair() {
    let link: PairingLink
    do {
      link = try PairingLink(address: KOSAddress(address.stringValue), code: code.stringValue)
    } catch let error as DeviceError {
      return say(error.message, failed: true)
    } catch {
      return say(error.localizedDescription, failed: true)
    }
    let label = name.stringValue.trimmingCharacters(in: .whitespaces)
    pairButton.isEnabled = false
    spinner.startAnimation(nil)
    say("Pairing with \(link.address.display)…")
    Task {
      defer {
        pairButton.isEnabled = true
        spinner.stopAnimation(nil)
      }
      do {
        let pairing = try await PairingClient.pair(link, name: label.isEmpty ? "Mac" : label)
        window.close()
        onPaired?(pairing)
      } catch let error as DeviceError {
        say(error.message, failed: true)
      } catch {
        say(error.localizedDescription, failed: true)
      }
    }
  }

  private func say(_ text: String, failed: Bool = false) {
    status.stringValue = text
    status.textColor = failed ? .systemRed : .secondaryLabelColor
  }
}
