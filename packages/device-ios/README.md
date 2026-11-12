# KOS for iPhone

A chat with your KOS on your phone, voice first, over your home Wi-Fi: press
the microphone and speak, hear the reply read aloud if you like, approve or
deny what KOS asks in one tap, and glance at what it is running, what is
failing and what runs next. It only chats: KOS cannot see or work the phone,
and a phone never gets a computer or browser session. The protocol, the phone
kind and the Wi-Fi listener are in [docs/computer.md](../../docs/computer.md).

## How it is built

- `PhoneCore`: the app's state, no views. `Phone` holds the pairing, the line
  and the chat; `PairingFlow`, `VoiceModel`, `ReplyReader` and `GlanceModel`
  are the machines the screens draw.
- `PhoneUI`: the screens (pairing, the chat, the approval, glance, chats and
  settings sheets) and `PhoneScene`, the whole app as one scene.
- `App/KOSPhoneApp.swift`: the app's one file of its own, with `App/Info.plist`.
  On a Mac it runs as a phone-sized window (`swift run KOSPhoneApp`), pairings
  in memory and no microphone.

Most of it is KOS for Mac's own code, shared through
[`packages/device-shared`](../device-shared): `DeviceCore` (the wire, signing,
pairing, the certificate pin, the glance), `DeviceKit` (Theme, Controls, the
face and its motion, `ChatModel`, `ChatCalls`, the chat's bubble, steps and
foot, markdown) and `DeviceLink` (`Connection`, `PairingClient`, the pairing
vaults). Both apps draw the chat from the same model and the same pieces.

## Build and test now (Command Line Tools only)

```sh
./scripts/test.sh                                        # every model, and every screen drawn
KOS_SNAPSHOT_DIR=/tmp/phone ./scripts/test.sh --filter RenderTests   # the screens as PNGs, 390 and 430 wide, light and dark
./scripts/e2e.sh <a template workspace> [KOS checkout]   # end to end against a scratch KOS
```

`scripts/test.sh` is `swift test`, pointed at the Testing framework when only
the Command Line Tools are installed. `scripts/e2e.sh` copies the workspace
(its database through a backup), turns its schedules, daemons and channels
off, starts a stub model and a host on 4425 (Wi-Fi listener on 4427, bound to
loopback), turns the listener on through the dashboard's API, makes a code,
and runs `EndToEndTests`: the Swift client pairs through the listener with
the link's pin, speaks and hears back, approves an ask (the command it allowed
runs), follows the theme as the dashboard changes it, refuses a line to
another certificate, and unpairs. The KOS checkout's `packages/cli/dist` must
be built.

## What only an iPhone has

Each is a small protocol in `PhoneCore`, with the iPhone's own behind
`#if os(iOS)` and a stand-in elsewhere:

| Adapter | On an iPhone | Elsewhere |
| --- | --- | --- |
| `SpeechRecognizer` | `SystemSpeechRecognizer`: Speech and AVAudioEngine, on the device where it can be | `NoSpeech` (says to type); tests script it |
| `Speaker` | `SystemSpeaker` (AVSpeechSynthesizer, spoken-audio session) | the same, real on a Mac too; tests listen |
| `Haptics` | `SystemHaptics` (UIKit feedback generators) | nothing |
| `PairingVault` | `KeychainVault`, after first unlock, this device only | `MemoryVault` |
| `Preferences` | `UserDefaults` | `MemoryPreferences` |

The keyboard's own dictation is the fallback for voice: the box is a plain
text field. Text sizes follow Dynamic Type (`KOSType.scaled`), every control
is at least 44 points, every button is named for VoiceOver, and motion stops
under Reduce Motion.

## Once Xcode is installed

1. `xcode-select -s /Applications/Xcode.app` and open Xcode once to install
   the iOS platform.
2. File, New, Project, iOS App, named "KOS", interface SwiftUI, saved in
   `packages/device-ios/Xcode` (not committed until it is settled). Delete the
   template's `ContentView.swift` and app file; add `App/KOSPhoneApp.swift`,
   and set the target's Info.plist to `App/Info.plist` (it declares the
   `kos-device` link, the microphone, speech recognition and the local network).
3. File, Add Package Dependencies, Add Local, pick `packages/device-ios`, and
   link the `PhoneUI` library to the app target.
4. Signing and Capabilities: Team, your Apple ID's free Personal Team; bundle
   id something of your own, `com.<you>.kos-phone`. A free team's builds last
   seven days on a phone, then need a rebuild.
5. Run it in the simulator (an iPhone 15). KOS on the same Mac: turn on
   Phones on this Wi-Fi in Settings, Devices, Add a device, and paste the link
   into the simulator.
6. On the phone: plug it in once, trust the Mac, turn on Developer Mode
   (Settings, Privacy and Security), pick it as the run destination and Run;
   trust your Personal Team under Settings, General, VPN and Device Management.
   After that, Window, Devices and Simulators, Connect via network lets Xcode
   install over Wi-Fi with the cable out.
7. The first pairing asks for the local network; voice asks for the
   microphone and speech recognition the first time you press it.

CI already builds `PhoneUI` for the iOS simulator on every pull request
(`.github/workflows/ci.yml`, `device-ios`), so the iOS-only code compiles
before Xcode is here.

Not yet: Bonjour discovery (the address is typed or comes in the link), the
app in the background (iOS closes the socket; the app dials again when it is
opened), and reading artifacts.
