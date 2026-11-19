# Setting KOS up

A runbook for a coding agent (Claude Code, Codex, Cursor and the like)
setting KOS up for its user, or for a person doing it by hand. Each step
says what to run and what a good result looks like. Do the steps in order;
skip a section marked optional when the user does not want it.

## What KOS is

KOS is a personal agent that runs on the user's own machine, in one
workspace directory it cannot leave, with its own tools, memory and
schedules. The user talks to it from a web dashboard, a terminal, and
optionally Discord, iMessage, SMS, their own Chrome, a Mac it may use, and
an iPhone.

At the end of this guide the user has:

- the KOS host running on `http://127.0.0.1:4317`, restarted after a crash
  and at login (macOS, launchd) or by Docker (Linux);
- a workspace at `~/kos-workspace` (or wherever they chose);
- at least one model answering;
- a secrets vault in `~/.kos/secrets`;
- whichever channels and devices they asked for, paired.

## Rules for the agent doing the setup

Read these before anything else and keep to them throughout.

1. **Never handle the user's credentials.** Do not type, paste, echo or
   store an API key, bot token, password, passphrase, PIN or phone
   credential, and do not ask the user to paste one into the chat. They go
   in one of three places, and the user puts them there:
   - the dashboard: Settings, Providers (model keys, the Discord token and
     owner id);
   - `.env` in the repository root, edited by the user in their own editor;
   - the vault, through the Secrets page or `kos secrets add`, which reads
     the value from a prompt that does not echo.
   You may write a `.env` line that names a variable with an empty value
   for the user to fill in. You may check that a variable is set without
   printing it: `grep -c '^ANTHROPIC_API_KEY=.' .env` prints `1` when it
   has a value.
2. **Stop and hand over** for anything that needs the user's hands: a
   System Settings grant (Full Disk Access, Screen Recording,
   Accessibility, Automation), a Keychain or signing PIN, an OAuth or
   browser sign-in, a Discord developer portal page, a Twilio console, a
   phone. Say exactly what to click, wait for them to say it is done, then
   run the check that proves it.
3. **Never run `sudo`** without asking the user first and saying why.
4. **Never commit `.env`**, a vault file, a key file or anything under
   `~/.kos`. `.env` is git-ignored; keep it that way.
5. **Do not open the user's ports to the network** (`KOS_HOST` other than
   `127.0.0.1`) unless they ask, and then set `KOS_DASHBOARD_TOKEN` too.
6. **Run every check.** A step is done when its check passes, not when its
   command returned.

## 1. Prerequisites

| Need | Check | Expect |
| --- | --- | --- |
| macOS (14 or later for KOS for Mac), or Linux | `uname -s`, and on a Mac `sw_vers -productVersion` | `Darwin` or `Linux`, and the macOS version |
| git | `git --version` | `git version 2.x` |
| Node 20 or newer (22 is what CI and the container use) | `node -v` | `v20.x` or later |
| pnpm 9.15.4 (pinned in `package.json`) | `pnpm -v` | `9.15.4` |
| ripgrep, for the search tool | `rg --version` | `ripgrep x.y.z` |
| Google Chrome, for KOS's browser (optional) | macOS: `ls "/Applications/Google Chrome.app"`; Linux: `command -v google-chrome google-chrome-stable chromium` | the path |
| Docker, Linux only (see 5c) | `docker compose version` | `Docker Compose version v2.x` |
| Xcode Command Line Tools, for KOS for Mac (optional) | `xcode-select -p` and `swift --version` | a path, and `Swift version 5.10` or later |
| Xcode, for KOS for iPhone (optional; the phone needs iOS 17) | `xcodebuild -version` | `Xcode 15.3` or later |

Fixes:

- Node: install from nodejs.org or with a version manager (`nvm install 22`).
- pnpm: `corepack enable` (ships with Node), then `pnpm -v` again. In the
  repository corepack picks the pinned version by itself.
- ripgrep: `brew install ripgrep` on macOS, `sudo apt-get install ripgrep`
  on Debian or Ubuntu (ask before `sudo`).
- Chrome: KOS also finds Chromium and Chrome Canary in their usual places.
  One elsewhere is named in Settings, Browser, or with `KOS_BROWSER_CHROME`
  in `.env`.

**Linux runs KOS in Docker.** Outside the container, on Linux, KOS refuses
shell and Python tools ("this needs a jail: run the host in the container
(docker compose up), or on macOS"). On macOS a sandbox profile is the jail
and KOS runs directly. iMessage and KOS for Mac are macOS only.

## 2. Install

```bash
git clone https://github.com/itsmarsss/kos-agent.git
cd kos-agent
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compiles every package, the dashboard and KOS for Chrome.

Check:

```bash
ls packages/cli/dist/main.js packages/ui/dist/index.html packages/browser-extension/dist/manifest.json
```

All three paths print, with no "No such file".

## 3. The `kos` command

The CLI is `packages/cli/dist/main.js`. From the repository root
`pnpm -s kos <args>` runs it. To have `kos` anywhere, put a small wrapper
on the PATH (run from the repository root):

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node "%s/packages/cli/dist/main.js" "$@"\n' "$PWD" > ~/.local/bin/kos
chmod +x ~/.local/bin/kos
```

If `~/.local/bin` is not on the PATH, add
`export PATH="$HOME/.local/bin:$PATH"` to the shell's profile
(`~/.zshrc` on macOS) and open a new shell.

Check: `command -v kos` prints `~/.local/bin/kos` (expanded).

The CLI reads `.env` from the repository root only (or the file
`KOS_ENV_FILE` names), so it works from anywhere, and a `.env` in the
current directory is never picked up.

## 4. Configuration and models

```bash
cp .env.example .env
```

`.env.example` documents every key; [configuration.md](configuration.md)
lists every setting. KOS is model agnostic: one provider is enough, and
which model answers each class of work (reasoning, cheap, screen, builds)
is chosen in Settings, Models.

| Provider | Where its key goes | Notes |
| --- | --- | --- |
| Anthropic API | `ANTHROPIC_API_KEY`, or Settings, Providers | preferred when both keys are set |
| OpenAI API | `OPENAI_API_KEY`, or Settings, Providers | works alone; also gives semantic memory its embeddings |
| Any OpenAI-compatible endpoint (a local server such as Ollama, a gateway, a self-hosted model) | `KOS_CUSTOM_BASE_URL` (or Settings, Models, custom endpoint), and its key, if it has one, in `KOS_SECRET_CUSTOM` | then pick `custom` as the provider for each class in Settings, Models |
| Claude subscription, through the Claude Agent SDK | no key: Claude Code installed and signed in on this machine (run `claude` and sign in) | Settings, Models, Chat engine: Claude Agent SDK. Chat turns then run on the subscription; the per-class model choices still apply to the rest |

Embeddings for semantic memory come from OpenAI when its key is set, else
from Cohere (`KOS_SECRET_COHERE`). With neither, recall still works but is
lexical, not semantic.

**The cheap route.** Background work (memory extraction, chat titles,
classifying, and any schedule set to cheap) runs on the cheap class. Point it at a small, inexpensive model in
Settings, Models, and keep the reasoning class for chat. Spend, under
Housekeeping, shows what each model costs.

Ask the user which provider they want, then have them put the key in
`.env` themselves (or in Settings, Providers once the host is up). Check
without printing it:

```bash
grep -cE '^(ANTHROPIC_API_KEY|OPENAI_API_KEY)=.' .env
```

`1` or `2` means a key is set. Then run the preflight:

```bash
kos doctor
```

Expect `ok` on node, ripgrep, the builds, `.env` and the workspace, and
`All checks passed.` The `model API key` line checks only the Anthropic and
OpenAI keys, so it fails on a custom endpoint or the subscription engine
alone; that is expected there. `semantic memory` fails without an OpenAI or
Cohere key; KOS still runs.

The model is proved once the host is up (step 5): `kos once "Reply with the
single word: ready"` prints a reply. Without a usable key it fails with
`/api/message: 400 {"error":"secret not found: anthropic"}` (or `openai`).

## 5. Workspace and first start

The workspace defaults to `~/kos-workspace`. To put it elsewhere, set
`KOS_WORKSPACE=/path` in `.env` before the first start. Keep it apart
from the repository and from `~/.kos`, where KOS keeps its keys and the
vault.

### 5a. First start, in the foreground

```bash
kos start --foreground
```

Expect, within a few seconds:

```
KOS host on http://127.0.0.1:4317
workspace: /Users/<user>/kos-workspace
session: primary:owner
sites: http://127.0.0.1:4318
ui: .../packages/ui/dist
Discord: skipped (set DISCORD_TOKEN + KOS_OWNER_DISCORD to enable)
```

Leave it running and, in another terminal, check:

```bash
kos status
curl -s http://127.0.0.1:4317/api/health
```

`kos status` prints `host: live (pid N) | discord: off | kill switch:
running | ...`. The health route answers `{"ok":true,...}`.

Open `http://127.0.0.1:4317` in the user's browser. It lands in a chat.
Stop the foreground host with Ctrl-C (it prints `shutting down…`).

`kos start` without `--foreground` starts the same host detached, logging
to `<workspace>/.kos/daemon.log`; `kos stop` and `kos restart` manage it.
For anything lasting, use the service below instead.

### 5b. The service (macOS)

```bash
kos service install
```

It stops a host started by hand, writes
`~/Library/LaunchAgents/dev.kos.host.plist` and has launchd start the host
now, after a crash and at login. Expect `KOS running under launchd on
http://127.0.0.1:4317; it restarts after a crash and starts at login`.

Check: `kos service status` prints `running under launchd (pid N)`, and
`kos status` prints `host: live`.

`kos stop`, `kos start` and `kos restart` work the same under launchd.
`kos service uninstall` removes it. The service runs from the repository,
so it reads the root `.env`; after editing `.env`, run `kos restart`.

### 5c. Linux: Docker

The container is the jail: it sees only the workspace (`./workspace`, or
`KOS_HOST_WORKSPACE`), restarts unless stopped, and publishes the dashboard
on `127.0.0.1:4317`. Inside it there is no write key, so every change needs
`KOS_DASHBOARD_TOKEN`. Add one first; this writes a random token to `.env`
without showing it to anyone:

```bash
printf 'KOS_DASHBOARD_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

The user then copies the token from `.env` into the dashboard, Settings,
Network, Dashboard token (the tab keeps it for the session). Check:

```bash
docker compose ps
docker compose exec kos node packages/cli/dist/main.js status
```

In the container, keys go in `.env` on the host followed by
`docker compose up -d`, not in Settings, Providers (the container's own
copy of the file does not last). The `kos` command runs inside it as
`docker compose exec kos node packages/cli/dist/main.js <args>`. The
container has no Chrome, so KOS's own browser is off there. Discord is
off too: the image runs `serve`, which implies `--no-discord`, and the log
says "Discord: off". To run the bot in the container, uncomment the
`command:` line in docker-compose.yml (`serve --discord`, which refuses to
start without the Discord keys in `.env`). The vault
in the container needs `KOS_VAULT_KEY` and `KOS_VAULT_ALLOW_SHARED_UID=1`
in `.env` (see [secrets.md](secrets.md), In the container).

### The write key, and reloading the dashboard

Every request that changes something must carry this boot's write key
(`x-kos-write`) or the dashboard token. KOS makes a new key at every start,
writes it into the dashboard page it serves and into `~/.kos/write.key`
(`write-<port>.key` on another port, mode 0600) for the CLI. So **after
any restart, reload every open dashboard tab**: a tab loaded before the
restart holds the old key, and its changes fail with 403 "A change to KOS
needs this boot's write key". Reads keep working, which is why it looks
half broken. A program that sends no key is not the owner, by design.

Restart from the dashboard with Settings, Workspace, Restart KOS: it waits
until no chat is mid-turn and no build is running. From a terminal,
`curl -s http://127.0.0.1:4317/api/status` shows `restart.busy`, the work
a restart would cut; restart when it is `[]`.

## 6. Secrets

KOS keeps two kinds (see [secrets.md](secrets.md)):

- **Harness keys** in `.env`: model keys, channel tokens, and any
  `KOS_SECRET_<NAME>`, which the agent can use as `{{secret:name}}` only in
  places it allows, and only to hosts listed in `KOS_SECRET_<NAME>_HOSTS`.
- **The vault**: the user's logins, cards, API keys and notes, encrypted in
  `~/.kos/secrets`, outside the workspace. The model never sees a value.

Make the vault, choosing one:

```bash
kos secrets init               # a key file: opens by itself at every start
kos secrets init --passphrase  # a passphrase alone: locked after every start
```

The tradeoff: a key-file vault is always ready, including for schedules,
but anything that can read `~/.kos/secrets/key` as the user can open it. A
passphrase vault is a real second factor (nothing on disk opens it), but
it is locked after every restart until the user unlocks it on the
dashboard or with `kos secrets unlock`; until then nothing in it can be
used and exact masking of its values is off. `--passphrase` prompts the
user; hand them the terminal.

Check:

```bash
kos secrets status
```

Expect `vault: ready (keyfile)` or `vault: locked (passphrase)`, and with
a host running a second line, `host: ready, 0 masked since it started`.
For a passphrase vault the first line always says `locked` (the CLI does
not hold the passphrase); the host line is the one that matters, and says
`host: locked` until the user unlocks it.

Adding secrets is the user's job. Either:

- the dashboard's Secrets page (`http://127.0.0.1:4317/#/secrets`, also
  under Settings, Permissions, Open Secrets), or
- `kos secrets add <login|card|apikey|note> <label> [--hosts a,b]
  [--origins https://x]`, which asks for each value at a prompt that does
  not echo. A value may also be piped in, for example
  `pbpaste | kos secrets add apikey Stripe --hosts api.stripe.com`.

`kos secrets list` shows handles, kinds, labels and hints, never values;
run it to confirm what the user added. Never put a value in an argument,
the chat, a commit or your own notes.

## 7. Safety settings

Ask the user to choose each of these; the defaults are the safe side.

- **Ask or Auto.** Every chat is in Ask (the default: a risky step asks
  first) or Auto (a risky step of the user's own turn runs without asking,
  and is logged as approved by Auto). The chip beside the composer sets it,
  per chat. Auto never covers a secret being placed, a payment, the kill
  switch, or a shell line outside a short reading and building list. See
  [browser-extension.md](browser-extension.md), The chat's mode.
- **Hosts read without asking:** `KOS_ALLOWED_HOSTS` (comma separated), or
  Settings, Network. A read from any other host asks; a remembered yes
  stands for that host. Writing to any host asks.
- **The local network:** `KOS_FETCH_LAN`, empty by default, so
  `http.fetch` reaches nothing on this machine or the home network. List
  only what KOS should reach, as `host:port`, `address:port`,
  `CIDR:port` or `loopback:<port>`, for example
  `KOS_FETCH_LAN=192.168.1.0/24:8123,nas.local:5000`.
- **Other names for KOS:** `KOS_HOST_NAMES`, comma separated. KOS answers
  only to localhost, its bound host, `KOS_PUBLIC_URL`'s host and these. Add
  a tunnel's name (Cloudflare, ngrok) or a tailnet name
  (`my-mac.tail1234.ts.net` under `tailscale serve`) when the user reaches
  KOS that way, and set `KOS_DASHBOARD_TOKEN` whenever KOS is reachable
  from beyond this machine.
- **Spend and unattended work:** Settings, Behaviour (steps per turn,
  unattended limits, whether KOS fixes its own failures) and Spend.
- **Memory jobs** (Read, Tidy, Condense under Memory, Jobs) are off until
  the user switches them on.

An edit to `.env` takes effect at `kos restart`; then reload the
dashboard. A value saved in Settings, Network applies as the page says
(the allowed hosts at once, ports and the bind address at the next start).

## 8. Channels (optional)

Each channel is one owner only: a message from anyone else is dropped,
never answered. Set the variables in `.env` (the user types the secret
ones), then `kos restart`. Details: [channels.md](channels.md).

### Discord

The user does, in the Discord developer portal:

1. New Application, then Bot: copy the token. Under Privileged Gateway
   Intents, turn on **Message Content Intent**.
2. OAuth2, URL Generator: scope `bot`; permissions View Channels, Send
   Messages, Send Messages in Threads, Create Public Threads, Read Message
   History, Add Reactions, Attach Files, Embed Links, and, for a server
   laid out as channels, Manage Channels, Manage Roles and Manage
   Webhooks. Open the URL and add the bot to a server of theirs (a bot
   DMs only someone it shares a server with).
3. In Discord, User Settings, Advanced, Developer Mode on; right-click
   their own name, Copy User ID; for a server layout, right-click the
   server, Copy Server ID.

Then in `.env`, or Settings, Providers and Settings, Network:

```
KOS_SECRET_DISCORD=     the bot token (the user pastes it)
KOS_OWNER_DISCORD=      their numeric user id
KOS_DISCORD_GUILD=      the server id, optional: KOS lays the dashboard out as channels
```

The agent can do: write the empty lines, restart, and check. After
`kos restart`, `kos status` shows `discord: on` and
`<workspace>/.kos/daemon.log` has `Discord: listening for DMs`. The user
DMs the bot "hello" and gets an answer.

### iMessage (macOS only)

KOS reads one thread, the user's note-to-self, and writes through
Messages.app.

```
KOS_OWNER_IMESSAGE=     the user's own phone number or Apple ID
```

Only the user can grant, in System Settings, Privacy and Security:

- **Full Disk Access** for the program that runs KOS. Under launchd that is
  the `node` binary itself: `command -v node` gives the path (for nvm,
  `~/.nvm/versions/node/v22.x.y/bin/node`; press Cmd-Shift-G in the file
  picker to paste it). Started from a terminal, it is the terminal app.
  `kos service install` prints this path when iMessage is configured.
- **Automation**, Messages, for the same program, asked the first time
  KOS sends.

Check after `kos restart`: `daemon.log` says `iMessage: watching your own
thread`. If it says `iMessage: not started.` it names the permission and
the binary that still need it; Settings, Providers says the same.

### SMS through Twilio

The user makes a Twilio account and number, and the host must be
reachable from the internet for Twilio's webhook (a tunnel is fine):

```
KOS_TWILIO_SID=
KOS_SECRET_TWILIO=      the auth token (the user pastes it)
KOS_TWILIO_FROM=        the Twilio number
KOS_OWNER_SMS=          the user's own number
KOS_PUBLIC_URL=         https://their-tunnel.example, when a proxy hides it
```

In the Twilio console the number's incoming message webhook is
`<public URL>/api/sms/inbound` (POST). Set `KOS_DASHBOARD_TOKEN`, since
KOS is now reachable from outside; if Twilio posts to a name other than
`KOS_PUBLIC_URL`'s, add that name to `KOS_HOST_NAMES`. Check: `daemon.log` says
`SMS: texts to <number> from your number arrive at POST /api/sms/inbound`,
and a text from the user's phone is answered. SMS has not been verified
against a live Twilio account.

## 9. Devices (optional)

A device is paired with a one-time code from Settings, Devices, Add a
device (good for ten minutes, one use). Devices dial out to KOS, so nothing
listens on them. If Settings, Devices or a pairing says "computer use is
switched off", switch the built-in `computer` module on in Settings,
Modules.

Check at any time: `curl -s http://127.0.0.1:4317/api/devices` lists each
paired device and whether it is online.

### KOS for Chrome (the user's own Chrome)

`pnpm build` already built it into `packages/browser-extension/dist`.

The user does:

1. `chrome://extensions`, Developer mode on, Load unpacked, pick
   `packages/browser-extension/dist` (the full path of the checkout).
2. Pin the KOS icon from the puzzle piece menu.
3. In KOS, Settings, Devices, Add a device, Copy link. Click the KOS icon,
   paste the link, Pair. It shows Connected.

Loaded unpacked from this folder, it reloads itself into each new build.
See [browser-extension.md](browser-extension.md).

### KOS for Mac (lets KOS see and use a Mac; macOS only)

Needs macOS 14 and the Xcode Command Line Tools, and `pnpm build` done (the
app is stamped with its build). Both commands need the user at the
keyboard; hand them over:

```bash
packages/device-macos/scripts/signing.sh setup
packages/device-macos/scripts/bundle.sh --install
```

- `signing.sh setup` makes a signing key in a keychain of its own and asks
  the user to choose a PIN (six characters or more, typed twice). With it,
  every rebuild is the same app to macOS and keeps its permissions, and KOS
  can update the app by itself. Without it builds are signed ad hoc and
  each one loses its grants.
- `bundle.sh --install` builds the app, signs it (macOS asks for the PIN
  once) and installs `~/Applications/KOS for Mac.app`, then opens it.

Then the user pairs: Settings, Devices, Add a device, open the link on the
Mac (or paste it into the app's window), check the address and press Pair.
The app asks for **Screen Recording** and **Accessibility**; only the user
can grant them in System Settings. Check: `scripts/signing.sh identity`
(run in `packages/device-macos`) prints a hash, and `/api/devices` lists
the Mac online. See [computer.md](computer.md) and
`packages/device-macos/README.md`.

A Mac other than the host reaches KOS only over https, a Tailscale address
or loopback; plain http elsewhere is refused.

### KOS for iPhone (chat only)

It needs Xcode and the user's Apple ID, and is built and installed from
Xcode; follow `packages/device-ios/README.md`, Once Xcode is installed.
The phone reaches KOS over the Wi-Fi listener:

1. Settings, Devices, turn on Phones on this Wi-Fi (or
   `KOS_DEVICE_LAN=1`). It listens on the dashboard port plus two (4319),
   TLS with KOS's own certificate, private addresses only. Leave it off on
   a shared network.
2. Add a device; open the link on the phone, check the certificate words
   match the dashboard's, and pair.

## 10. Final checklist

Run each; every line should pass.

```bash
kos doctor                                 # All checks passed (see step 4 for expected failures)
kos service status                         # running under launchd (pid N)      [macOS]
kos status                                 # host: live (pid N) | ...
curl -s http://127.0.0.1:4317/api/health   # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4317/   # 200
kos once "Reply with the single word: ready"   # a reply from the model
kos secrets status                         # vault: ready (or locked, passphrase) and host: ready
curl -s http://127.0.0.1:4317/api/devices  # paired devices, online: true          [if paired]
grep -c '^\.env$' .gitignore               # 1: .env stays out of git
git status --short .env                    # prints nothing
```

Then in the browser: `http://127.0.0.1:4317` loads, a message in the chat
gets an answer, and the user knows to reload the tab after every restart.

## 11. Troubleshooting

**Port in use.** `kos start` says the host did not become ready, or the
log has `EADDRINUSE`. See what holds it: `lsof -nP -iTCP:4317
-sTCP:LISTEN`. If it is an older KOS, `kos stop` (or `kos restart`, which
waits for the port). Otherwise set `KOS_PORT` to a free port; sites use
the next port, and the Wi-Fi listener, when it is on, the one after.

**Chrome not found.** A browser tool fails with "no Chrome found; name its
path under Settings > Browser". Install Google Chrome, or name the binary
in Settings, Browser or with `KOS_BROWSER_CHROME=/path/to/chrome`, then
`kos restart`. KOS's Chrome uses DevTools port 9225; a second KOS on one
machine needs `KOS_BROWSER_PORT`.

**"computer use is switched off".** Settings, Modules, switch the built-in
`computer` module on. Pairing and the devices list answer again at once.

**Discord never connects.** `kos status` says `discord: off`:

- `Discord: skipped` in the log: `KOS_SECRET_DISCORD` or
  `KOS_OWNER_DISCORD` is empty.
- A token or intent error: the token was reset (copy it again) or Message
  Content Intent is off in the portal.
- Timeouts, `ENOTFOUND` or `ECONNRESET` for discord.com or
  gateway.discord.gg: a network filter (a school, office or DNS filter, a
  firewall) blocks Discord. Check with `curl -sI https://discord.com/api/v10/gateway`;
  if that fails, use another network or have the user allow Discord.
  The dashboard and every other surface keep working meanwhile.

**Dashboard 403 after a restart.** "A change to KOS needs this boot's write
key": reload the tab. With `KOS_DASHBOARD_TOKEN` set (always in Docker),
enter the token in Settings, Network, Dashboard token. A 401
"unauthorized" means a token is set and this tab or script does not send
it.

**Vault locked after a restart.** A passphrase vault is locked after every
start by design: `kos secrets status` says `host: locked`. The user
unlocks it on the Secrets page or with `kos secrets unlock`. Passphrase
tries are limited to five in ten minutes. "both sequence records are
gone": see [secrets.md](secrets.md), `kos secrets trust-seq`.

**A chat turn fails with "secret not found: anthropic".** No usable model
key. Add one (step 4), or point Settings, Models at the provider the user
does have.

**`shell.run` refuses with "this needs a jail".** KOS is running directly
on Linux. Run it with Docker (step 5c).

**iMessage not started.** The log names the grant and the binary; grant
Full Disk Access to that exact `node` path, then `kos restart`. A Node
upgrade changes the path, so the grant must be given again.

**The service will not stay up.** `<workspace>/.kos/daemon.log` has the
reason. launchd waits between restarts of a host that exits at once (a
port in use, a broken `.env`).
