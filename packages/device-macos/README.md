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
./scripts/test.sh              # the protocol, session and input rules, and every window drawn
```

`scripts/test.sh` is `swift test`, pointed at the Testing framework when only
the Command Line Tools are installed. With `KOS_SNAPSHOT_DIR` set, each window
state is also written there as a PNG.

Open `~/Applications/KOS Device.app`. It lives in the menu bar; its one
window (Open KOS Device in the menu) holds the pairing, the permissions and
your rules for this Mac.

## Pair

1. In KOS: Settings, Devices, Add a device.
2. Open the link it shows on this Mac, or paste it (or the address and code)
   into the window. Check the address is your KOS and press Pair.

KOS must be reachable over https, a Tailscale address, or on this Mac itself
(`http://127.0.0.1:4317`). Plain http anywhere else is refused.

A Mac can be paired with more than one KOS, say one at home and one at work:
Add a KOS in the window pairs another the same way. Each KOS has its own card,
its own line, its own keys and its own Ask before each session. The Mac has one
screen, so one session runs at a time: while one KOS has it, another that asks
hears the Mac is busy, and only the KOS that owns a session can act in it or
end it. Pairing again with a KOS already here replaces that pairing.

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

This is a cost of building from source, not of the app. A release signed with
an Apple Developer ID would carry the same identity from one update to the
next, so its grants would carry over with nothing to set up; there is no such
release yet. Until there is, if you rebuild often, give your builds a signing
key of your own, once:

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
  session on that KOS's card; then that KOS's approval queue decides instead.
- Touch the mouse, trackpad or keyboard and KOS pauses. Resume or Stop from
  the bar at the top of the screen, or from the menu. Settings, What pauses
  KOS sets how much of a move it takes: any move, a real move (the default), or
  only clicks and keys.
- Password fields are never typed into. Apps under Hidden from KOS are left out
  of what KOS sees and cannot be clicked or typed in; password managers are
  there from the start.
- A session ends at its time limit, after the idle limit, on Stop, on Quit,
  or the moment the line to the KOS that owns it drops.

## Settings

Behind the gear, kept on this Mac, and nothing KOS sends can change them:

- Sessions: the longest one, how long the prompt waits for an answer, and the
  idle limit.
- While KOS works: what pauses it, and whether its pointer glides so you can
  follow it or gets there quickly.
- App: open at login, connect when it opens, sounds when KOS asks and when a
  session starts or ends, and the time left beside the menu bar icon.
- Diagnostics: Copy log puts this run's log on the clipboard to send.

## Log

KOS Device writes each line's dialling, proofs, drops and redials, each
pairing read and kept, and each session asked, allowed, paused and ended, to
the system log. Tasks are kept private.

```sh
log show --predicate 'subsystem == "com.itsmarsss.kos-device"' --last 1h
```
