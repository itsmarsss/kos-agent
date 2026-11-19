# AGENTS.md

You are a coding agent asked to set KOS up for your user. Follow
[docs/setup.md](docs/setup.md) step by step and run each step's check
before moving on.

If you are changing KOS's code rather than setting it up, this file does
not apply: start from the guides in [docs/](docs/).

## Do

- Check prerequisites first: Node 22.5 or newer, pnpm 9.15.4, git, ripgrep;
  Google Chrome for the browser; Docker on Linux; the Xcode Command Line
  Tools only for KOS for Mac.
- Install with `pnpm install --frozen-lockfile` and `pnpm build`.
- Start with `kos start --foreground` once, then `kos service install` on
  macOS or `docker compose up -d --build` on Linux.
- Prove each part: `kos doctor`, `kos status`, `curl -s
  http://127.0.0.1:4317/api/health`, `kos secrets status`.
- Ask the user before each optional part: channels, devices, vault
  passphrase, Auto mode, network settings.
- Tell the user to reload dashboard tabs after every restart.

## Never

- Type, paste, echo or store the user's API keys, tokens, passwords,
  passphrases or PINs, or ask for them in chat. The user puts them in
  `.env` in their own editor, in Settings, Providers, or through
  `kos secrets add`, which prompts without echo.
- Click through a GUI grant, Keychain or signing PIN, OAuth sign-in, or
  developer portal for the user. Stop, say exactly what to do, wait, then
  check.
- Run `sudo` without asking first.
- Commit `.env`, anything under `~/.kos`, or the workspace.
- Bind KOS beyond `127.0.0.1` without the user asking, and never without
  `KOS_DASHBOARD_TOKEN`.

Troubleshooting is at the end of [docs/setup.md](docs/setup.md).
