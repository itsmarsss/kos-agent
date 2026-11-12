# KOS for iPhone

A chat with your KOS on your phone, voice first, over your home Wi-Fi: press
the microphone and speak, hear the reply read aloud if you like, send a photo
or a file with your words, approve or deny what KOS asks in one tap, and read
the docs, decks and sheets KOS makes. Beside the chat are the dashboard's own
pages, drawn for a phone: the Inbox, artifacts, projects, and under More the
overview, runs, blobs, files, memory and settings. It only chats: KOS cannot see or work the phone,
and a phone never gets a computer or browser session. The protocol, the phone
kind and the Wi-Fi listener are in [docs/computer.md](../../docs/computer.md).

## How it is built

- `PhoneCore`: the app's state, no views. `Phone` holds the pairing, the line
  and the chat; `PairingFlow`, `VoiceModel`, `ReplyReader`, `GlanceModel`,
  `ArtifactShelf` (the artifacts to read, the one open, and a sheet's row
  tapped), `AttachmentTray` (the files going with the next words) and
  `HandsFree` (Ask KOS) are the machines the screens draw. `Board` holds the
  dashboard's pages: `Dashboard` asks the dashboard's own routes over the line
  by call number (docs/computer.md, The dashboard's pages), `Page` keeps what
  one read, and `InboxModel`, `ProjectsModel`, `GalleryModel`, `BlobsModel`,
  `FilesModel`, `MemoryModel`, `RunsModel` and `OverviewModel` are each page's;
  `Routes` reads what the routes answer.
- `PhoneUI`: the screens (pairing; the tabs, `PhoneHome` and `TabBar`; the
  chat with its approval and chats sheets; each page; the artifact viewer and
  its row sheet) and `PhoneScene`, the whole app as one scene; `AskKOS`, the
  App Intent. `PageKit` is what every page is drawn from.
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
node scripts/artifact-fixtures.mjs /tmp/fixtures         # a doc, a deck and a sheet as KOS draws them for a phone
KOS_ARTIFACT_FIXTURES=/tmp/fixtures KOS_SNAPSHOT_DIR=/tmp/phone ./scripts/test.sh --filter RenderTests
./scripts/e2e.sh <a template workspace> [KOS checkout]   # end to end against a scratch KOS
```

The viewer's renders draw each artifact in the viewer's own web view, off the
screen, and set its picture where the view goes. Without
`KOS_ARTIFACT_FIXTURES` a small page stands in for each kind;
`artifact-fixtures.mjs` needs the checkout's `harness` and `ui` builds.

`scripts/test.sh` is `swift test`, pointed at the Testing framework when only
the Command Line Tools are installed. `scripts/e2e.sh` copies the workspace
(its database through a backup), turns its schedules, daemons and channels
off, starts a stub model and a host on 4425 (Wi-Fi listener on 4427, bound to
loopback), turns the listener on through the dashboard's API, makes a code,
and runs `EndToEndTests`: the Swift client pairs through the listener with
the link's pin, speaks and hears back, approves an ask (the command it allowed
runs), sends a photo the turn is shown, opens a doc KOS wrote (the dashboard's
frame, read-only) and has a read of it answered, then browses the dashboard's
pages: denies an ask from the Inbox, opens a project, runs a schedule now and
pauses it, and reads a file; it follows the theme as the dashboard changes it,
refuses a line to another certificate, and unpairs. The
KOS checkout's `packages/cli/dist` and `packages/ui/dist` must be built.

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
| `ArtifactFrame` | `WKWebView` (UIKit) | the same `WKWebView` (AppKit), tested and drawn |
| `Picking` | `PhotosPicker` and the file importer, a file read under its grant | the same pickers |
| `AskKOS` | an App Intent and its App Shortcut | none |

Photos are brought down to 2048 pixels on the long side as JPEG with ImageIO,
which both systems have; files go as they are, five megabytes and four to a
message at most, and only what KOS reads (pictures, PDFs, Office files, text).

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
   Do not add `App/Info.plist` to the target as a file: as a resource it is
   copied into the bundle a second time, and the build fails.
3. File, Add Package Dependencies, Add Local, pick `packages/device-ios`, and
   link the `PhoneUI` library to the app target. Under the target's Build
   Phases, add a Run Script phase last, `"$SRCROOT/../scripts/stamp.sh"`, and
   set Build Settings, User Script Sandboxing to No: it stamps the app with
   its build (docs/computer.md, Builds and updates), so KOS can say when a
   newer one is ready. It needs KOS's packages built (`pnpm build`); without
   them the app builds unstamped, with a warning.
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

## The tabs

Chat, Inbox, Artifacts, Projects and More, at the foot as an iPhone app keeps
them. Chat opens the app and stays voice first; the Inbox is next, since
deciding what waits is what a phone is reached for most, and carries the
count; More holds the overview (the glance, grown to the dashboard's first
page), runs, blobs, files, memory and the phone's settings. Each tab keeps its
place while another is shown, and pressing the shown tab goes back to its top.
Every page reads the dashboard's own routes over the line, so it says what the
dashboard says; pulling one reads it again. What a phone does better is there
too: swipe an ask right to approve and left to deny, with a tap felt; long
press for the remembered yes, to run a schedule now or pause it, or to share an
artifact as its PDF, Markdown, CSV or HTML; search on the Inbox's decided,
the artifacts, the projects and memory; files open as what they are, a
picture to pinch or a PDF as the system draws one, with Share.

## Reading artifacts

The chats sheet lists the last few artifacts changed, and an artifact KOS
names in a reply (`@page:<id>`) opens at a tap. The viewer is the dashboard's
frame, built by KOS from the dashboard's own runtimes and sent over the line
(docs/computer.md, Artifacts), marked as the phone's so it reads as part of
the app: edge to edge on the app's own ground, with no box around it and the
title only in the viewer's bar. A doc reads in the app's gutter; a sheet's
grid scrolls sideways under a frozen first column and a sticky head, and a
row tapped opens as the phone's own sheet with every field labelled; a deck
reads upright as a column of numbered slides; turned on its side, the viewer
turns with it (the rest of the app stays upright) and the deck fills the
screen a slide at a time, moved with a swipe, a tap on either half, or the bar
under it. All artifacts goes to the Artifacts tab. Each follows the app's
light and dark. It only shows: the frame reaches no network (its
policy, and a content rule list under it, without which nothing is shown),
never navigates, opens nothing outside itself, and its window.kos takes
reads alone, which KOS answers as it answers the dashboard's; a mention in a
doc opens that artifact only at the owner's press.

## Hands-free

Ask KOS opens the app listening, so a question needs no tap. It is an App
Intent, so Siri, Shortcuts and the Action button all offer it, with the
phrases "Ask KOS" and "Talk to KOS". No link starts listening, since any app
or page can open one. It closes an open artifact first, so the chat it is
said in shows; opened before KOS is on the line, the app listens once the
chat is shown. Spoken words go alone: a file in the box goes only with words
sent from the box, where the owner sees it going.

The Action button (iPhone 15 Pro and later):

1. Settings, Action Button, swipe to Shortcut, then Choose a Shortcut.
2. Under KOS, pick Ask KOS.
3. Press and hold the Action button: KOS opens listening. Speak, and pause to
   send, or press the button on the screen.

The app target takes the intents in with `KOSIntents` (an
`AppIntentsPackage` naming `PhoneIntents`), in `App/KOSPhoneApp.swift`, beside
the App Shortcut.

## Updates

An iPhone app cannot update itself: its code comes from Xcode. When KOS has
a newer build of this app than the one on the phone, More shows a quiet "An
update is ready", which opens Settings with the steps: open the KOS project
in Xcode on the Mac, pick this iPhone, and press Run. KOS lists the phone as
behind in Settings, Devices. Everything on the KOS side is live already.

Not yet: Bonjour discovery (the address is typed or comes in the link), and
the app in the background (iOS closes the socket; the app dials again when it
is opened).
