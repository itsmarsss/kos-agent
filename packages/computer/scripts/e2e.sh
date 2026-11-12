#!/usr/bin/env bash
# Device updates end to end, against a scratch KOS: a copy of a workspace with its schedules, daemons and
# channels off, answering from a stub model. KOS for Chrome, in a Chrome of its own, reloads into KOS's build;
# a stand-in KOS for Mac behind waits for its turn to end, then the installer runs once. Nothing is built,
# signed or installed: the installer and the signing check are stubs (KOS_DEVICE_MAC_INSTALL, _SIGNING).
#
#   scripts/e2e.sh <template workspace> [KOS checkout, default this one]
#
# Ports: the dashboard on KOS_E2E_PORT (4417), sites on the next, the Wi-Fi listener on the one after, the
# stub model on the one after that, KOS's own browser on the one after that, and the test Chrome's DevTools
# on the one after that. The checkout's packages must be built (pnpm build). KOS_E2E_SHOTS=<dir> keeps the
# dashboard's Devices settings as PNGs, in each theme.
set -euo pipefail
cd "$(dirname "$0")/.."

TEMPLATE="${1:?the template workspace to copy}"
ROOT="$(cd "${2:-../..}" && pwd)"
PORT="${KOS_E2E_PORT:-4417}"
LAN=$((PORT + 2))
MODEL=$((PORT + 3))
BROWSER=$((PORT + 4))
CDP=$((PORT + 5))
# A Chrome for Testing, which still loads an unpacked extension from the command line (branded Chrome does not).
CHROME="${KOS_E2E_CHROME:-$(ls -d "$HOME"/.cache/puppeteer/chrome/*/chrome-mac-*/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | tail -1)}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/kos-updates-e2e.XXXXXX")"
WS="$DIR/ws"
DASH="http://127.0.0.1:$PORT"
PIDS=()

stop() {
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [[ "${KOS_E2E_KEEP:-}" == "" ]]; then rm -rf "$DIR"; else echo "kept $DIR"; fi
}
trap stop EXIT

[[ -x "$CHROME" ]] || { echo "no Chrome for Testing found; set KOS_E2E_CHROME (npx @puppeteer/browsers install chrome@stable)" >&2; exit 1; }
for p in "$PORT" $((PORT + 1)) "$LAN" "$MODEL" "$BROWSER" "$CDP"; do
  if lsof -iTCP:"$p" -sTCP:LISTEN -n -P >/dev/null 2>&1; then echo "port $p is in use" >&2; exit 1; fi
done

# The workspace, copied: its database read through a backup, so a host using the template is not disturbed.
mkdir -p "$WS"
rsync -a --exclude 'kos.sqlite*' --exclude '.kos' "$TEMPLATE/" "$WS/"
sqlite3 "$TEMPLATE/kos.sqlite" ".backup '$WS/kos.sqlite'"
set_setting() {
  sqlite3 "$WS/kos.sqlite" "insert into settings (key, value, updated_at) values ('$1', '$2', $(date +%s)000)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
}
BEHAVIOUR="$(sqlite3 "$WS/kos.sqlite" "select value from settings where key = 'behaviour'")"
set_setting behaviour "$(node -e 'const b = JSON.parse(process.argv[1] || "{}"); console.log(JSON.stringify({ ...b, engine: "api", autoFix: false, memoryExtraction: false }))' "$BEHAVIOUR")"
set_setting models '{"reasoning":{"provider":"custom","model":"stub-1"},"cheap":{"provider":"custom","model":"stub-1"}}'
set_setting models.custom "{\"baseUrl\":\"http://127.0.0.1:$MODEL/v1\"}"
sqlite3 "$WS/kos.sqlite" "update crons set enabled = 0; update daemons set enabled = 0;"
# Paired devices and their updates are the template's own; this run pairs its own.
sqlite3 "$WS/kos.sqlite" "delete from devices; delete from device_updates;" 2>/dev/null || true

# The installer and the signing check, played: each install is a line in installs.log, and signing is set up.
printf '#!/bin/sh\necho "Built build/KOS for Mac.app (stub)"\necho install >> "%s/installs.log"\n' "$DIR" > "$DIR/installer.sh"
printf '#!/bin/sh\necho E2E-IDENTITY\n' > "$DIR/signing.sh"
chmod +x "$DIR/installer.sh" "$DIR/signing.sh"

node scripts/e2e/stubmodel.mjs "$MODEL" > "$DIR/model.log" 2>&1 &
PIDS+=($!)

env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DISCORD_TOKEN= KOS_OWNER_DISCORD= KOS_DISCORD_GUILD= KOS_OWNER_IMESSAGE= \
  KOS_DEVICE_KEY_FILE="$DIR/device-host.key" KOS_DEVICE_LAN_CERT_FILE="$DIR/device-lan.pem" \
  KOS_DEVICE_LAN_HOST=127.0.0.1 KOS_DEVICE_LAN_PORT="$LAN" KOS_BROWSER_PORT="$BROWSER" \
  KOS_DEVICE_MAC_INSTALL="$DIR/installer.sh" KOS_DEVICE_MAC_SIGNING="$DIR/signing.sh" \
  node "$ROOT/packages/cli/dist/main.js" serve --workspace "$WS" --host 127.0.0.1 --port "$PORT" --no-discord > "$DIR/host.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 120); do
  curl -sf "$DASH/api/status" >/dev/null && break
  sleep 0.5
done
curl -sf "$DASH/api/status" >/dev/null || { echo "the host did not come up:" >&2; tail -30 "$DIR/host.log" >&2; exit 1; }

if ! KOS_E2E_DASHBOARD="$DASH" KOS_E2E_WORKSPACE="$WS" KOS_E2E_ROOT="$ROOT" KOS_E2E_DIR="$DIR" KOS_E2E_CHROME="$CHROME" KOS_E2E_CDP_PORT="$CDP" \
  node scripts/e2e/updates.mjs; then
  echo "--- host.log" >&2
  grep -i "device" "$DIR/host.log" | tail -30 >&2 || true
  exit 1
fi
grep "KOS for Mac update" "$DIR/host.log" || true
