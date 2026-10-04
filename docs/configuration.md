# Configuration

`.env` next to the repository is read by the `kos` command and is
git-ignored. `.env.example` documents every key. Most of what follows is
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

Settings, Models chooses the engine (the model provider, or the Claude Agent
SDK on your subscription), the model for each task class (reasoning, cheap,
and builds), the custom endpoint and the classifier. Rates for pricing go
under Spend.

## Host

```
KOS_WORKSPACE=           default ~/kos-workspace
KOS_HOST=                default 127.0.0.1; anything else exposes KOS to the network
KOS_PORT=                default 4317; sites are served on the next port
KOS_DASHBOARD_TOKEN=     bearer token for every API route; set one if reachable beyond this machine
KOS_HOOK_SECRET=         enables POST /api/hooks/<job>
KOS_ALLOWED_HOSTS=       hosts http.fetch may reach
KOS_UI_DIST=             built UI, default packages/ui/dist
```

## Channels

See [channels.md](channels.md).

## Secrets

Any `KOS_SECRET_NAME` is exposed to the agent as `{{secret:name}}`: injected
at call time, never shown to the model, redacted from logs.

## Behaviour (Settings, Behaviour)

Whether KOS tries to fix a failing job on its own, steps per turn and per
fix attempt, self-prompts per hour, the heartbeat interval (0 is off), and
background memory extraction with its threshold.

## Appearance (Settings, Appearance)

Dark, light or system; compact, standard or comfortable. Kept in the
browser, so a phone and a desk can differ.

## The CLI

```
kos start | stop | restart        the host
kos service install|uninstall|status   launchd (macOS)
kos                                attach a REPL
kos once "message"                 one message
kos module install|update|remove|list
kos eval memory [--agent] | dream | observe
kos memory-mcp --token kosc_...    memory as an MCP server
kos doctor                         preflight
```
