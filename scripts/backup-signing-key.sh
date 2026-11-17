#!/bin/bash
# Backs up the key that signs MacReach releases. If it is lost, every user has to grant Screen Recording and Accessibility again
# after the next update, because macOS ties those grants to the signing identity.
#   scripts/backup-signing-key.sh /path/to/MacReach-signing-backup.enc      (the passphrase is asked here, in your Terminal)
#   restore: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in FILE | tar -xzf - -C "$HOME/Library/Application Support/MacReach"
# Keep the backup somewhere safe and OFF this Mac (a password manager attachment, an encrypted USB stick). Never put it in git.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HOME/Library/Application Support/MacReach/signing"
OUT="${1:-}"
[ -n "$OUT" ] || { echo "Usage: $0 <output file>" >&2; exit 2; }
[ -f "$SRC/identity.txt" ] && [ -f "$SRC/macreach-signing.keychain-db" ] || { echo "No signing key yet: run scripts/setup-signing.sh first." >&2; exit 1; }
[ ! -e "$OUT" ] || { echo "$OUT already exists; choose a new name." >&2; exit 1; }
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
case "$OUT_ABS" in "$ROOT"/*) echo "Refusing to write the backup inside the repository." >&2; exit 1;; esac
umask 077
tar -C "$(dirname "$SRC")" -czf - signing | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -out "$OUT_ABS"
echo "Wrote $OUT_ABS. Store it away from this Mac, and remember the passphrase: there is no way to recover it."
