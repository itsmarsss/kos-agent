# Computer use

KOS can see and work a computer the owner has paired: the screen, the
pointer, the keyboard. The KOS core never leaves its jail to do it. A computer
is reached only through **KOS Device**, an app the owner installs on it, which
dials out to KOS, enforces its own rules, and shows the owner every moment it
is being driven.

Two packages, one protocol:

- `packages/computer` (`@kos/computer`): the KOS side. Pairing, the socket
  devices connect to, sessions, and the `computer.*` tools.
- `packages/device-macos`: KOS Device for macOS, a menu bar app.
- `packages/browser-extension`: the KOS extension, a device that offers a
  Chrome's tabs instead of a screen (see [browser-extension.md](browser-extension.md)).

The computer KOS runs on and a laptop across the internet are the same case:
KOS Device on the host Mac dials `127.0.0.1`, on the laptop it dials the
server. The device always connects out, so nothing listens on it.

## Using it

1. Settings, Devices, Add a device. KOS shows a code and a link.
2. On the computer, open KOS Device and paste the link (or the address and
   code). The link opens it directly when the dashboard is on that computer.
3. Grant Screen Recording and Accessibility when it asks.

Then any chat can ask: "on my laptop, open the Figma file from yesterday".
The device asks you to allow the session, for how long, and the session
starts.

While KOS is in control:

- a glowing border runs round the screen it is using;
- its cursor glides to each point, marked as KOS's;
- a bar at the top says what it is doing, with Pause and Stop;
- touching the mouse, trackpad or keyboard pauses it at once, and only you
  resume it, on the device;
- it does not type while a password field has focus;
- apps on the device's hidden list (password managers by default) are blanked
  from what it sees, and it cannot act on them.

## Reaching a server

A device must reach KOS over an encrypted path: `https` (a reverse proxy in
front of the host), a Tailscale address, or loopback. Plain `http` to any
other address is refused by the device. Tailscale is the simple answer for a
home server or a VPS: the laptop and the host join one tailnet and the device
uses the host's tailnet name.

## Security model

- **Pairing** is a one-time code made on the dashboard, good for ten minutes
  and one use. The device sends its public key with the code; KOS answers with
  its own. Each side keeps the other's key. A device may be paired with more
  than one KOS: each pairing has its own keys, line and consent, and each KOS
  sees the device as one of its own.
- **Every connection** proves both keys: KOS signs the device's nonce, the
  device signs KOS's. A host that cannot sign is not KOS, whatever its address.
- **Consent lives on the device.** By default every session is allowed by the
  owner on the device itself. The owner may switch that off on the device for
  unattended use; KOS then asks through its approval queue instead. Nothing
  KOS sends can change the device's settings.
- **A session is bounded**: one at a time across every KOS the device is
  paired with (another that asks is answered `busy`), ended at its time limit,
  when idle, on Stop, when the app quits, and when the connection to the KOS
  that owns it drops. Only that KOS can act in it or end it. KOS's
  kill switch ends every session. The device sets the longest session and the
  idle limit; KOS only says how long it asks for.
- **Work the owner did not start stays off.** A schedule, a blob's own timer
  or a guest in a channel cannot start a session unless the owner allows it
  in Settings, Devices, and then the device still asks.
- Keys: the device's lives in its Keychain; KOS's lives outside the workspace
  (`~/.kos/device-host.key`, `KOS_DEVICE_KEY_FILE` to move it, or
  `KOS_DEVICE_HOST_KEY` as base64 PKCS#8 for a container), so the agent never
  reads it. It is not a `KOS_SECRET_` name: those the agent can place in a
  request.

## Protocol

Version 1. JSON over a WebSocket at `/api/devices/socket`, text frames, one
message per frame, at most 16 MB. Every message has a type `t`.

### Pairing (HTTP)

`POST /api/devices/pairings` (owner, dashboard token) makes a code:

```json
{ "code": "K7QX-M2PA", "expiresAt": 1761800000000 }
```

`POST /api/devices/pair` (no token; the code is the proof):

```json
{ "code": "K7QX-M2PA", "name": "Studio MacBook", "platform": "macos", "publicKey": "<base64, 32 bytes Ed25519>" }
```

answers `{ "device": "dev_...", "hostKey": "<base64, 32 bytes>", "protocol": 1 }`.
A wrong code is a 403. After ten wrong codes in ten minutes every open code
is void.

The pairing link is `kos-device://pair?url=<KOS address>&code=<code>`.

### Handshake

1. KOS: `{ "t": "challenge", "protocol": 1, "nonce": "<base64, 32 bytes>" }`
2. Device, within 10 s:

```json
{
  "t": "hello",
  "protocol": 1,
  "device": "dev_...",
  "nonce": "<base64, 32 bytes>",
  "signature": "<Ed25519 over 'kos-device/1|device|<KOS nonce>|<device id>'>",
  "app": { "version": "0.1.0", "platform": "macos", "os": "26.4.1" },
  "consent": "device",
  "permissions": { "screen": true, "input": true },
  "displays": [{ "id": 1, "width": 1512, "height": 982, "scale": 2, "main": true }]
}
```

3. KOS: `{ "t": "welcome", "name": "<device name>", "signature": "<Ed25519 over 'kos-device/1|host|<device nonce>|<device id>'>" }`

Nonces are signed as their base64 text. Either side closes on a bad
signature. Close codes: `4001` malformed, `4003` unknown device or bad
signature, `4009` replaced by a newer connection of the same device, `4010`
protocol version not spoken.

After the welcome the device sends `{ "t": "state", ... }` with `consent`,
`permissions` and `displays` whenever one changes.

### Calls

KOS: `{ "t": "call", "id": 7, "method": "pointer.click", "params": { ... } }`

Device: `{ "t": "reply", "id": 7, "ok": true, "result": { ... } }` or
`{ "t": "reply", "id": 7, "ok": false, "error": { "code": "paused", "message": "..." } }`

Every method but `session.begin` takes `session`, and the device refuses it
without that session live.

| Method | Params | Result |
| --- | --- | --- |
| `session.begin` | `session`, `task`, `requester`, `conversation?`, `target? {app}`, `minutes`, `maxEdge?` | `granted`, `until`, `space {width,height}`, `target {kind, app?, title?}` |
| `session.end` | `session` | `{}` |
| `screen.capture` | `session`, `region? {x,y,width,height}` | `image` (base64), `mediaType`, `width`, `height`, `cursor {x,y}`, `app?` |
| `pointer.move` | `session`, `x`, `y` | `cursor` |
| `pointer.click` | `session`, `x`, `y`, `button?` (left, right, middle), `count?` (1 to 3), `modifiers?` | `cursor` |
| `pointer.drag` | `session`, `from {x,y}`, `to {x,y}` | `cursor` |
| `pointer.scroll` | `session`, `x`, `y`, `dx`, `dy` (lines; positive is down and right) | `cursor` |
| `keys.type` | `session`, `text` (at most 4000 characters) | `cursor` |
| `keys.press` | `session`, `keys` (one combination, `cmd+shift+t`), `repeat?` | `cursor` |

**What is shared.** The owner picks, as a screen-sharing picker offers it: the
entire screen, or one window. `target.app` is the app KOS would work in; its
window is offered first. With a window, `space` is that window, a capture is
that window alone (whatever covers it), every call lands in it after it is
brought to the front, and the session ends (`window`) if it closes. The
answer's `target` says which was shared.

`session.begin` is answered when the owner decides, or when the prompt's wait (60 s unless the owner set it) runs out, as `denied`.
`minutes` is what KOS asks for; the owner may choose less. `requester` is the
asking chat's title and `conversation` its id, so the device can link the
owner to it on the dashboard (`<KOS address>/#/chats/<id>`).

**Coordinates** are in the session's `space`: the screen in points, scaled
down to fit `maxEdge` (default 1280) on its long side. A capture without a
`region` is exactly `space` in pixels, so a point in the picture is a point to
click. A capture with a `region` is that part at up to `maxEdge`, for reading
detail; calls still take `space` coordinates.

`app` names the app in front: `{ "name": "Safari", "bundle": "com.apple.Safari" }`.

Key names: letters, digits, `return`, `tab`, `space`, `escape`, `backspace`,
`delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`,
`f1` to `f20`, and punctuation by itself (`-`, `=`, `[`, `/`, ...). Modifiers:
`cmd`, `shift`, `ctrl`, `alt` (`option`), `fn`. xdotool spellings
(`Return`, `super+c`, `Page_Down`) are read too.

### Events

Device: `{ "t": "event", "name": "session.paused", "data": { "session": "...", "reason": "owner" } }`

| Event | Data |
| --- | --- |
| `session.paused` | `session`, `reason` (`owner`: they touched the mouse or keyboard) |
| `session.resumed` | `session` |
| `session.extended` | `session`, `until` (the owner gave it more time on the device) |
| `session.ended` | `session`, `reason` (`owner`, `expired`, `idle`, `quit`, `host`, `window`) |

### Errors

`no_session`, `paused`, `busy` (another session is live), `denied`,
`permission` (Screen Recording or Accessibility not granted), `secure_input`
(a password field has focus), `hidden_app` (the target is on the hidden list),
`bad_request`, `internal`.
