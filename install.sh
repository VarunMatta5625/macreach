#!/bin/bash
# MacReach one-shot installer. Safe to re-run: every step is skipped when already done.
#   ./install.sh                 full install (asks nothing; installs missing tools with Homebrew if present)
#   ./install.sh --no-tailscale  skip Tailscale (MacReach then only works on this Mac)
# At the end the MacReach menu bar app opens its setup assistant, which asks for every macOS permission in one place.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WANT_TS=1; for a in "$@"; do [ "$a" = "--no-tailscale" ] && WANT_TS=0; done
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "MacReach runs on macOS only."
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 14 ] || die "macOS 14 or newer is required (this is $(sw_vers -productVersion))."
case "$ROOT" in *[!A-Za-z0-9/._\ -]*) die "Path contains unusual characters: $ROOT";; esac

# Homebrew (Apple Silicon: /opt/homebrew, Intel: /usr/local)
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
HAVE_BREW=0; command -v brew >/dev/null 2>&1 && HAVE_BREW=1

say "Xcode Command Line Tools (Swift)"
if ! xcode-select -p >/dev/null 2>&1 || ! command -v swift >/dev/null 2>&1; then
  xcode-select --install 2>/dev/null || true
  die "Installing the Xcode Command Line Tools. Finish the macOS dialog that just opened, then run ./install.sh again."
fi
SWV="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9]*\).*/\1/p' | head -1)"
[ "${SWV:-0}" -ge 6 ] || die "Swift 6 or newer is required (found ${SWV:-none}). Update the Command Line Tools: softwareupdate --list, or install Xcode 16+."
echo "swift $SWV ok"

say "Node.js"
if ! command -v node >/dev/null 2>&1; then
  [ "$HAVE_BREW" = 1 ] || die "Node.js 24.7 or newer is required. Install Homebrew (https://brew.sh) or Node from https://nodejs.org, then run ./install.sh again."
  brew install node
fi
# crypto.argon2 (password hashing) first shipped in Node 24.7
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 7) ? 0 : 1)' \
  || die "Node.js 24.7 or newer is required (found $(node -v)). Run: brew upgrade node"
echo "node $(node -v) ok"

say "Server dependency (ws)"
if [ ! -d "$ROOT/server/node_modules/ws" ]; then
  command -v npm >/dev/null 2>&1 || die "npm not found next to node."
  (cd "$ROOT/server" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2)
else echo "already installed"; fi

say "Tailscale"
if [ "$WANT_TS" = 0 ]; then echo "skipped (--no-tailscale)"
elif command -v tailscale >/dev/null 2>&1 && command -v tailscaled >/dev/null 2>&1; then echo "already installed"
elif [ "$HAVE_BREW" = 1 ]; then brew install --formula tailscale
else echo "Homebrew not found: skipping. Install later with: brew install --formula tailscale && macreach install"; fi

say "Building and signing the MacReach app"
"$ROOT/scripts/build-helper.sh"

say "Installing and starting MacReach"
"$ROOT/bin/macreach" install

case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo; echo "Note: add ~/.local/bin to your PATH to use the 'macreach' command:"; echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc";; esac

cat <<'DONE'

==> Done.
The MacReach icon is now in your menu bar and its Setup assistant is open. In that window:
  1. Grant Screen Recording and Accessibility (macOS shows its own prompts; MacReach restarts itself afterwards).
  2. Set your password (opens Terminal; the password is typed only there).
  3. Optional: sign in to Tailscale and set up the private link to reach this Mac from your other devices.
DONE
