#!/bin/bash
# Builds helper and assembles + signs ~/Applications/MacReach.app (stable path + stable signature => stable TCC grants)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_OUT:-$HOME/Applications/MacReach.app}"   # APP_OUT: scripts/make-dmg.sh builds somewhere else and signs last
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION" 2>/dev/null || echo dev)"
D="$HOME/Library/Application Support/MacReach/signing"
"$ROOT/scripts/setup-signing.sh" >/dev/null
security unlock-keychain -p "$(cat "$D/kc.pw")" "$D/macreach-signing.keychain-db"
# Build outside the repo: a copied folder may carry a stale .build with another machine's absolute paths
SCRATCH="$HOME/Library/Caches/MacReach/build"
(cd "$ROOT/helper" && swift build -c release --scratch-path "$SCRATCH" 2>&1 | tail -3)
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# App icon: draw the PNGs, pack them into an .icns (must be in place before codesign seals the bundle)
ICONTMP="$(mktemp -d)"; trap 'rm -rf "$ICONTMP"' EXIT
swift "$ROOT/scripts/make-icons.swift" "$ICONTMP/AppIcon.iconset" >/dev/null
iconutil -c icns "$ICONTMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
cp "$SCRATCH/release/MacReachHelper" "$APP/Contents/MacOS/MacReach"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.macreach.helper</string>
<key>CFBundleName</key><string>MacReach</string>
<key>CFBundleDisplayName</key><string>MacReach</string>
<key>CFBundleExecutable</key><string>MacReach</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>com.macreach.helper</string><key>CFBundleURLSchemes</key><array><string>macreach</string></array></dict></array>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSUserNotificationsUsageDescription</key><string>MacReach tells you when a remote device starts controlling this Mac.</string>
<key>NSScreenCaptureUsageDescription</key><string>MacReach streams your screen to your own authenticated browser sessions.</string>
</dict></plist>
PL
[ -n "${NO_SIGN:-}" ] && { echo "built $APP (unsigned)"; exit 0; }
codesign --force --keychain "$D/macreach-signing.keychain-db" -s "$(cat "$D/identity.txt")" -i com.macreach.helper "$APP"
codesign -dr - "$APP" 2>&1 | grep designated
echo "built $APP"
