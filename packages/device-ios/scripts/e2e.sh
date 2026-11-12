#!/usr/bin/env bash
# The phone end to end, against a scratch KOS: a copy of a workspace with its schedules, daemons and channels
# off, answering from a stub model that costs nothing. The Swift client pairs over KOS's Wi-Fi listener (bound
# to loopback here), says something and hears back, approves an ask, sends a picture the turn is shown, reads
# an artifact KOS made as the dashboard draws it, and is sent the dashboard's theme.
#
#   scripts/e2e.sh <template workspace> [KOS checkout, default this one]
#
# Ports: the dashboard on KOS_E2E_PORT (4425), sites on the next, the Wi-Fi listener on the one after, the
# stub model on the one after that, and KOS's own browser on the one after that. The KOS checkout's
# packages/cli/dist and packages/ui/dist must be built (pnpm build:ts, pnpm build:ui): the artifact is drawn
# from the dashboard's build.
set -euo pipefail
cd "$(dirname "$0")/.."

TEMPLATE="${1:?the template workspace to copy}"
ROOT="$(cd "${2:-../..}" && pwd)"
PORT="${KOS_E2E_PORT:-4425}"
LAN=$((PORT + 2))
MODEL=$((PORT + 3))
BROWSER=$((PORT + 4))
DIR="$(mktemp -d "${TMPDIR:-/tmp}/kos-phone-e2e.XXXXXX")"
WS="$DIR/ws"
DASH="http://127.0.0.1:$PORT"
PIDS=()

stop() {
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [[ "${KOS_E2E_KEEP:-}" == "" ]]; then rm -rf "$DIR"; else echo "kept $DIR"; fi
}
trap stop EXIT

for p in "$PORT" $((PORT + 1)) "$LAN" "$MODEL" "$BROWSER"; do
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

node scripts/e2e/stubmodel.mjs "$MODEL" > "$DIR/model.log" 2>&1 &
PIDS+=($!)

env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DISCORD_TOKEN= KOS_OWNER_DISCORD= KOS_DISCORD_GUILD= KOS_OWNER_IMESSAGE= \
  KOS_DEVICE_KEY_FILE="$DIR/device-host.key" KOS_DEVICE_LAN_CERT_FILE="$DIR/device-lan.pem" \
  KOS_DEVICE_LAN_HOST=127.0.0.1 KOS_DEVICE_LAN_PORT="$LAN" KOS_BROWSER_PORT="$BROWSER" \
  node "$ROOT/packages/cli/dist/main.js" serve --workspace "$WS" --host 127.0.0.1 --port "$PORT" --no-discord > "$DIR/host.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 120); do
  curl -sf "$DASH/api/status" >/dev/null && break
  sleep 0.5
done
curl -sf "$DASH/api/status" >/dev/null || { echo "the host did not come up:" >&2; tail -30 "$DIR/host.log" >&2; exit 1; }

# Off by default: nothing listens for phones until the owner turns it on.
if curl -sk --max-time 3 "https://127.0.0.1:$LAN/api/devices/lan" >/dev/null; then echo "the Wi-Fi listener was on by default" >&2; exit 1; fi
curl -sf -X POST -H 'content-type: application/json' -d '{"lan":true}' "$DASH/api/devices/settings" >/dev/null
# On, it serves the device routes alone.
STATUS="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$LAN/api/status")"
[[ "$STATUS" == "404" ]] || { echo "the Wi-Fi listener answered /api/status with $STATUS" >&2; exit 1; }

CODE_JSON="$(curl -sf -X POST "$DASH/api/devices/pairings")"
LINK="$(node -e 'const c = JSON.parse(process.argv[1]); if (!c.lan) process.exit(1); console.log(`kos-device://pair?url=${encodeURIComponent(c.lan.url)}&code=${c.code}&pin=${c.lan.pin}`)' "$CODE_JSON")"

KOS_E2E_LINK="$LINK" KOS_E2E_DASHBOARD="$DASH" KOS_E2E_WORKSPACE="$WS" ./scripts/test.sh --filter EndToEnd
