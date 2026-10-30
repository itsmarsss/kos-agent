# KOS Device for macOS

The menu bar app that lets KOS see and use this Mac, only in sessions you
allow, with a glowing border, KOS's own cursor and a Stop button on screen the
whole time. It dials out to KOS; nothing listens on this Mac. The protocol and
the security model are in [docs/computer.md](../../docs/computer.md).

## Build and install

Needs macOS 14 or later and the Xcode Command Line Tools.

```sh
./scripts/bundle.sh            # builds build/KOS Device.app
./scripts/bundle.sh --install  # and copies it to ~/Applications
swift test                     # the protocol, session and input rules
```

Open `~/Applications/KOS Device.app`. It lives in the menu bar; its one
window (Open KOS Device in the menu) holds the pairing, the permissions and
your rules for this Mac.

## Pair

1. In KOS: Settings, Devices, Add a device.
2. Open the link it shows on this Mac, or paste it (or the address and code)
   into the window. Check the address is your KOS and press Pair.

KOS must be reachable over https, a Tailscale address, or on this Mac itself
(`http://127.0.0.1:4317`). Plain http anywhere else is refused.

## Permissions

The app asks for two, in System Settings, Privacy & Security:

- **Screen Recording**, to show KOS the screen.
- **Accessibility**, to move the pointer and type, and to notice when you take over.

The window shows both, and Grant opens the right switch.

Signed ad hoc (the default), macOS ties these grants, and the app's keychain
access, to this exact build: after a rebuild the old build's row still shows
in System Settings, switched on, and does nothing for the new one. Press
Grant in the window: it clears this app's old row and macOS asks again.
Screen Recording applies once the app starts again; the window offers
Restart.

To keep them across builds, give KOS Device a signing key of its own:

```sh
./scripts/signing.sh setup   # asks for a PIN of your choosing, twice
```

Every build is then the same app to macOS. A build asks for the PIN, not your
login password, and then macOS asks for the permissions one last time. The
key lives in a keychain of its own, locked by that PIN, so nothing running as
you can sign code with it and inherit the grants; it locks again after five
minutes and when the Mac sleeps. `./scripts/signing.sh remove` goes back to ad
hoc.

## While KOS has the Mac

- Every session is allowed here first, unless you turn off Ask before each
  session in the window; then KOS's approval queue decides instead.
- Touch the mouse, trackpad or keyboard and KOS pauses. Resume or Stop from
  the bar at the top of the screen, or from the menu.
- Password fields are never typed into. Apps under Hidden from KOS are left out
  of what KOS sees and cannot be clicked or typed in; password managers are
  there from the start.
- A session ends at its time limit, after three idle minutes, on Stop, on Quit,
  or the moment the line to KOS drops.
