#!/usr/bin/env bash
# A signing key for KOS Device that stays the same from build to build, in a
# keychain of its own, locked by a PIN you choose.
#
# Signed ad hoc, every build is a new app to macOS: its Screen Recording and
# Accessibility grants, and its keychain access, go with each rebuild. Signed
# with one key, they stay. The PIN is what keeps that safe: without it, anything
# running as you could sign its own code with the key and inherit the grants.
# A build asks for the PIN once; the keychain locks again after five minutes
# and when the Mac sleeps.
#
#   scripts/signing.sh setup      make the key (asks for a PIN, twice)
#   scripts/signing.sh identity   the key's hash, for bundle.sh
#   scripts/signing.sh remove     delete the key; builds go back to ad hoc
set -euo pipefail

KEYCHAIN="${KOS_DEVICE_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/kos-device-signing.keychain-db}"
NAME="KOS Device Local Signing"

case "${1:-}" in
  setup)
    if [[ -e "$KEYCHAIN" ]]; then
      echo "A KOS Device signing key already exists ($KEYCHAIN)." >&2
      exit 1
    fi
    read -r -s -p "Choose a PIN for the KOS Device signing key (6 or more characters): " PIN
    echo
    read -r -s -p "Again: " AGAIN
    echo
    if [[ "$PIN" != "$AGAIN" ]]; then echo "The two did not match." >&2; exit 1; fi
    if (( ${#PIN} < 6 )); then echo "Six characters at least." >&2; exit 1; fi

    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$NAME" \
      -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
      -addext "basicConstraints=critical,CA:false" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
    # macOS reads only the older PKCS#12 form.
    openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -out "$WORK/id.p12" -passout "pass:$PIN" \
      -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1

    security create-keychain -p "$PIN" "$KEYCHAIN"
    security set-keychain-settings -l -u -t 300 "$KEYCHAIN"
    security unlock-keychain -p "$PIN" "$KEYCHAIN"
    security import "$WORK/id.p12" -k "$KEYCHAIN" -P "$PIN" -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PIN" "$KEYCHAIN" >/dev/null
    security lock-keychain "$KEYCHAIN"
    echo "Made. The next build asks for this PIN once, and macOS asks for KOS Device's permissions one last time."
    ;;
  identity)
    [[ -e "$KEYCHAIN" ]] || exit 1
    security find-identity -p codesigning "$KEYCHAIN" | awk -v name="\"$NAME\"" 'index($0, name) { print $2; exit }'
    ;;
  remove)
    security delete-keychain "$KEYCHAIN"
    echo "Removed. Builds are signed ad hoc again."
    ;;
  *)
    echo "usage: $0 setup | identity | remove" >&2
    exit 2
    ;;
esac
