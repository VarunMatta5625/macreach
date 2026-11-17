#!/bin/bash
# Builds dist/MacReach-<version>-arm64.dmg: a self-contained MacReach.app (helper, server, web client, Node and Tailscale inside)
# signed with this Mac's MacReach signing key, in a disk image with an Applications shortcut and a first-run note.
#   scripts/make-dmg.sh
# Needs: Xcode command line tools (Swift 6), Homebrew's tailscale (brew install --formula tailscale) as the source of the Tailscale
# binaries, and network access once to fetch Node (cached; the download is checked against a pinned SHA-256).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
NODE_VERSION="v24.22.3"      # crypto.argon2 (password hashing) needs Node 24.7+
NODE_SHA256="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"   # node-v24.22.3-darwin-arm64.tar.gz, from nodejs.org SHASUMS256.txt
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || die "Build on an Apple Silicon Mac (the image is arm64 only)."

CACHE="$HOME/Library/Caches/MacReach/dist"; mkdir -p "$CACHE"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
APP="$WORK/MacReach.app"
D="$HOME/Library/Application Support/MacReach/signing"

say "Node $NODE_VERSION"
TGZ="$CACHE/node-$NODE_VERSION-darwin-arm64.tar.gz"
if [ ! -f "$TGZ" ]; then curl -fsSL -o "$TGZ" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz"; fi
[ "$(shasum -a 256 "$TGZ" | awk '{print $1}')" = "$NODE_SHA256" ] || { rm -f "$TGZ"; die "Node download does not match the pinned checksum. Deleted it; run again."; }
tar -xzf "$TGZ" -C "$WORK" "node-$NODE_VERSION-darwin-arm64/bin/node" "node-$NODE_VERSION-darwin-arm64/LICENSE"
NODE_BIN="$WORK/node-$NODE_VERSION-darwin-arm64/bin/node"; NODE_LICENSE="$WORK/node-$NODE_VERSION-darwin-arm64/LICENSE"

say "Tailscale binaries"
TS="$(command -v tailscale || true)"; TSD="$(command -v tailscaled || true)"
[ -n "$TS" ] && [ -n "$TSD" ] || die "Install Tailscale first (brew install --formula tailscale): its binaries go into the app."
for b in "$TS" "$TSD"; do
  bad="$(otool -L "$b" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/Library/)' || true)"
  [ -z "$bad" ] || die "$b depends on libraries outside the system, so it cannot be bundled: $bad"
done
TS_LICENSE="$(ls "$(dirname "$(readlink -f "$TS")")"/../LICENSE 2>/dev/null | head -1 || true)"
TS_VERSION="$("$TS" version 2>/dev/null | head -1)"
echo "tailscale $TS_VERSION"

say "Server dependency"
[ -d "$ROOT/server/node_modules/ws" ] || (cd "$ROOT/server" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2)

say "Building the app"
APP_OUT="$APP" NO_SIGN=1 "$ROOT/scripts/build-helper.sh" | tail -1
R="$APP/Contents/Resources/macreach"
mkdir -p "$R/bin" "$R/server/node_modules" "$R/web" "$APP/Contents/Resources/Licenses"
cp "$ROOT/bin/macreach" "$R/bin/macreach"; chmod 755 "$R/bin/macreach"
cp -R "$ROOT/server/src" "$ROOT/server/package.json" "$R/server/"
cp -R "$ROOT/server/node_modules/ws" "$R/server/node_modules/ws"
cp -R "$ROOT/web/." "$R/web/"
echo "$VERSION" > "$R/VERSION"
find "$R" -name .DS_Store -delete
cat > "$APP/Contents/Resources/macreach-cli" <<'SH'
#!/bin/sh
# MacReach command line: runs the app's own Node on the app's own copy of the tool.
D="$(cd "$(dirname "$0")" && pwd)"
exec "$D/../MacOS/node" "$D/macreach/bin/macreach" "$@"
SH
chmod 755 "$APP/Contents/Resources/macreach-cli"
cp "$NODE_BIN" "$APP/Contents/MacOS/node"; cp -L "$TS" "$APP/Contents/MacOS/tailscale"; cp -L "$TSD" "$APP/Contents/MacOS/tailscaled"
chmod 755 "$APP/Contents/MacOS/"*

say "Licenses"
L="$APP/Contents/Resources/Licenses"
cp "$NODE_LICENSE" "$L/Node.js-LICENSE.txt"
[ -n "$TS_LICENSE" ] && cp "$TS_LICENSE" "$L/Tailscale-LICENSE.txt"
cp "$ROOT/server/node_modules/ws/LICENSE" "$L/ws-LICENSE.txt"
cat > "$L/README.txt" <<TXT
MacReach $VERSION bundles these programs. Their licenses are in this folder.
  Node.js $NODE_VERSION  (MIT)           https://nodejs.org
  Tailscale $TS_VERSION  (BSD-3-Clause)  https://github.com/tailscale/tailscale
  ws (WebSocket library) (MIT)           https://github.com/websockets/ws
TXT

say "Signing"
"$ROOT/scripts/setup-signing.sh" >/dev/null
security unlock-keychain -p "$(cat "$D/kc.pw")" "$D/macreach-signing.keychain-db"
ID="$(cat "$D/identity.txt")"; KC="$D/macreach-signing.keychain-db"
# Inner programs first, then the app that seals them. No hardened runtime: this is not notarized, and Node needs JIT.
for n in node tailscale tailscaled; do codesign --force --keychain "$KC" -s "$ID" -i "com.macreach.$n" "$APP/Contents/MacOS/$n"; done
codesign --force --keychain "$KC" -s "$ID" -i com.macreach.helper "$APP"
codesign --verify --deep --strict -vv "$APP" 2>&1 | tail -2
codesign -dr - "$APP" 2>&1 | grep designated

say "Disk image"
STAGE="$WORK/dmg"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/MacReach.app"; ln -s /Applications "$STAGE/Applications"
cp "$ROOT/scripts/dmg-readme.txt" "$STAGE/READ ME FIRST.txt"
mkdir -p "$ROOT/dist"; OUT="$ROOT/dist/MacReach-$VERSION-arm64.dmg"; rm -f "$OUT"
hdiutil create -quiet -volname "MacReach $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT"
hdiutil verify -quiet "$OUT"
( cd "$ROOT/dist" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
ls -la "$OUT" | awk '{printf "built %s (%.0f MB)\n", $9, $5/1048576}'
cat "$OUT.sha256"
