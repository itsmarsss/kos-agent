#!/usr/bin/env bash
# The app target's Run Script phase (README, Once Xcode is installed): stamps the build of KOS for iPhone
# (docs/computer.md, Builds and updates) as build.json in the app's resources, from this checkout. Xcode's
# PATH has no Node from Homebrew or nvm, so it is looked for. Without one, or before KOS's packages are
# built, the app is built unstamped, which KOS reads as a build it does not know: a warning, not a failure.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${TARGET_BUILD_DIR:?run from Xcode}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?run from Xcode}/build.json"
NODE="${KOS_NODE:-$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)}"
if [[ -z "$NODE" ]] || ! "$NODE" ../computer/dist/stamp.js phone "$OUT"; then
  echo "warning: KOS for iPhone was not stamped with its build; build KOS first (pnpm build), with Node installed"
fi
