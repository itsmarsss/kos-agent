# Configuration

`.env` at the repository root is read by the `kos` command and is
git-ignored. `KOS_ENV_FILE`, set in the shell, names another file instead.
A `.env` in the current directory is never read: run from the workspace,
it would be a file the agent's approved programs can write. `.env.example` documents every key. Most of what follows is
also settable in the dashboard.

## Models

```
ANTHROPIC_API_KEY=       preferred when both are set
OPENAI_API_KEY=          works alone
KOS_CUSTOM_BASE_URL=     any OpenAI-compatible endpoint: a local server, a gateway
KOS_SECRET_CUSTOM=       its key, if it wants one
KOS_CLASSIFIER_URL=      a "which of these" model for typed questions
KOS_SECRET_CLASSIFIER=
KOS_SECRET_COHERE=       embeddings when OpenAI is not configured
```

Each of these keys may live in the vault instead, as an API key naming its
harness name (`openai`, `anthropic`, `custom`, `classifier`, `cohere`;
Secrets, below). A key set here wins over the vault's.

Settings, Models chooses the engine (the model provider, or the Claude Agent
SDK on your subscription), the model for each task class (reasoning, cheap,
and builds), the custom endpoint and the classifier. Rates for pricing go
under Spend.

## Host

```
KOS_WORKSPACE=           default ~/kos-workspace
KOS_HOST=                default 127.0.0.1; anything else exposes KOS to the network, and needs KOS_DASHBOARD_TOKEN
KOS_PORT=                default 4317; sites are served on the next port
KOS_DASHBOARD_TOKEN=     bearer token for every API route; required to listen beyond loopback
KOS_HOOK_SECRET=         enables POST /api/hooks/<job>; or set it in Settings, Providers, where KOS keeps only a check of it
KOS_ALLOWED_HOSTS=       hosts http.fetch reads without asking; any other host asks you first, and a yes you remember stands for that host
KOS_FETCH_LAN=           places on your own network http.fetch may reach, empty by default: host:port, address:port or CIDR:port, and loopback:<port> for a program on this machine, comma separated (192.168.1.0/24:8123, nas.local:5000, loopback:8080); KOS's own ports never, whatever is listed
KOS_HOST_NAMES=          other names you reach KOS by, comma separated: a tunnel's (Cloudflare, ngrok), your tailnet's (my-mac.tail1234.ts.net under tailscale serve), a proxy's, the host Twilio posts to when it is not KOS_PUBLIC_URL's. Every route answers only to localhost, the bound host, KOS_PUBLIC_URL's host, KOS_DEVICE_LAN_HOST, these, or an address; any other name is refused with 421
KOS_WRITE_KEY_FILE=      where this boot's write key is kept for the kos CLI, default ~/.kos/write.key (write-<port>.key for another port)
KOS_UI_DIST=             built UI, default packages/ui/dist
KOS_DEVICE_KEY_FILE=     KOS's key for paired computers, default ~/.kos/device-host.key
KOS_DEVICE_HOST_KEY=     the same key as base64 PKCS#8, for a container whose home does not last
KOS_APNS_KEY_FILE=       the APNs .p8 key that pushes asks to paired iPhones, outside the workspace (or KOS_APNS_KEY, its text); off unless set here or in Settings, Devices (docs/computer.md, Push)
KOS_APNS_KEY_ID=         that key's 10-character id
KOS_APNS_TEAM_ID=        the Apple developer team's 10-character id
KOS_APNS_TOPIC=          KOS for iPhone's bundle id
```

Every request that changes something carries this boot's write key
(`x-kos-write`) or the dashboard token: a program on the machine that sends
no Origin is not the owner. KOS writes the key into the dashboard page it
serves and into a file only you can read (0600, `KOS_WRITE_KEY_FILE`),
which the kos CLI and the dev server's proxy read and every jailed program
is denied; it is never in the environment. In the container, where the
agent's programs share loopback with KOS, there is no key: every change
needs `KOS_DASHBOARD_TOKEN`. A tab without it is asked for it before the
dashboard draws (and again whenever KOS answers 401); it is also in
Settings, Network, Dashboard token. The tab keeps it in session storage
(gone when it closes, never on disk) and sends it as `x-kos-token` with
every request. What the browser fetches by itself (an image, a player, a
framed PDF) goes by an address KOS signs for the holder through
`/api/sign`, so the token never goes into a URL: only those routes are
signed, a picture's for 15 minutes (signed again before it lapses or when
it fails), a player's or a PDF's for 6 hours, and the socket's ticket for a
minute and one connection. The
dashboard's page and files are sent with `frame-ancestors 'none'` and
`X-Frame-Options: DENY`, so no other page can frame it. Every route answers only to KOS's own names
(localhost, the bound host, `KOS_PUBLIC_URL`'s, the Wi-Fi host) or an
address, so a page whose name was rebound onto this machine is refused.

`http.fetch` never reaches this machine, its local network (IPv6 forms
that carry an IPv4 address included) or KOS's own hosts, except the places
`KOS_FETCH_LAN` lists; each redirect and each resolved address is checked
as it connects. On the Mac, jailed programs never connect to KOS's ports
(the API, the sites server, the Wi-Fi listener and KOS's Chrome's debugging
port) on any address. In the container the container is the jail: a
command runs unwrapped beside KOS, on its network, so a chat's Auto never
runs `shell.run` there unasked. KOS's browser never works a tab that is on
its dashboard.
Apps the agent runs are served on the sites server's origin, never the
dashboard's, without your token, key or cookies.

Computer use and pairing a device: [computer.md](computer.md).

## Channels

See [channels.md](channels.md).

## Secrets

The keys KOS runs on (the model keys above, `DISCORD_TOKEN`,
`TWILIO_AUTH_TOKEN`, any `KOS_SECRET_NAME`) are read from this file when
they are set here, which always wins, else from the encrypted vault: an API
key there whose `use.harness` names them (`openai`, `discord`, `twilio`,
`name`). Settings, Providers saves into the vault while it is open (and
takes the name out of this file) and into this file only when there is no
vault; each key says where its live value is read from. `kos secrets
migrate-env` moves what this file holds into the vault, after a confirm,
and blanks the values here, keeping the names as comments. A vault KOS for
Mac opens at login is read at once: no restart for a model key, and Discord
and SMS start when it opens with theirs. The dashboard token stays here.
See [secrets.md](secrets.md), Keys KOS runs on.

Any `KOS_SECRET_NAME` is exposed to the agent as `{{secret:name}}`: injected
at call time, never shown to the model, redacted from logs. A reference works
only in an `http.fetch` header or its URL's query string, and in an MCP
server's env, headers or url query; any other tool or place refuses the call.
Where a secret may go is the owner's to say, in the same file:

- `KOS_SECRET_NAME_HOSTS` (comma separated, `*.example.com` allowed): the
  hosts `http.fetch` may send it to. A secret bound to no host is not sent.
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are bound to their own APIs.
- `KOS_SECRET_NAME_MCP` (comma separated): the servers in `mcp.json` that may
  be given it. A stdio server has no host, so it cannot take a host-bound
  secret.

Every call that sends a secret asks the owner, naming the secret and the
host; no remembered yes and no Auto covers it. A redirect to another site is
not followed with it. A value that comes back in a tool's answer, as it is or
encoded, is replaced by `[secret name]` before the model or a log sees it; so
are the harness's own credentials (bot and dashboard tokens, device keys, any
env var ending in TOKEN, KEY, SECRET or PASSWORD).

## Behaviour (Settings, Behaviour)

Whether KOS tries to fix a failing job on its own, steps per turn and per
fix attempt, self-prompts per hour, the heartbeat interval (0 is off), and
background memory extraction with its threshold.

## Appearance (Settings, Appearance)

Theme: dark, light or system (the default). KOS's own setting,
`appearance.theme` in the workspace (`GET`/`POST /api/settings/theme`, and
`theme` on `/api/status` once chosen): every tab of the dashboard follows a
change made in another, and KOS sends it to every paired device, which draws
it unless the owner set that device's own theme. The browser keeps a copy
for the first paint. Density: compact, standard or comfortable, kept in the
browser, so a phone and a desk can differ.

## The CLI

```
kos start | stop | restart        the host
kos service install|uninstall|status   launchd (macOS)
kos                                attach a REPL
kos once "message"                 one message
kos module install|update|remove|list
kos eval memory [--agent] | dream | observe
kos memory-mcp                     memory as an MCP server (KOS_CALLER_TOKEN=kosc_...)
kos doctor                         preflight
```
