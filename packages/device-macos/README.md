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

Open `~/Applications/KOS Device.app`. It lives in the menu bar.

## Pair

1. In KOS: Settings, Devices, Add a device.
2. Open the link it shows on this Mac, or paste it (or the address and code)
   into Pair with KOS. Check the address is your KOS and press Pair.

KOS must be reachable over https, a Tailscale address, or on this Mac itself
(`http://127.0.0.1:4317`). Plain http anywhere else is refused.

## Permissions

The app asks for two, in System Settings, Privacy & Security:

- **Screen Recording**, to show KOS the screen.
- **Accessibility**, to move the pointer and type, and to notice when you take over.

Permissions... in the menu shows both and opens the right switch.

The app is signed ad hoc, so macOS ties these grants to this exact build.
After a rebuild, macOS may show the grants as on while they no longer apply:
switch KOS Device off and on again in both lists.

## While KOS has the Mac

- Every session is allowed here first, unless you turn off Ask before each
  session in the menu; then KOS's approval queue decides instead.
- Touch the mouse, trackpad or keyboard and KOS pauses. Resume or Stop from
  the bar at the top of the screen, or from the menu.
- Password fields are never typed into. Apps under Hidden apps... are left out
  of what KOS sees and cannot be clicked or typed in; password managers are
  there from the start.
- A session ends at its time limit, after three idle minutes, on Stop, on Quit,
  or the moment the line to KOS drops.
