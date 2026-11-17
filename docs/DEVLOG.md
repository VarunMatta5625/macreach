# MacReach: development log

Engineering decisions, gotchas and verification notes, newest at the bottom. (Written while the project was built in many sessions; the first section is the original design.)

Goal: browser-based remote control of this Mac from any device, via Tailscale Serve (private) + Funnel (public).
Original brief is long; the essentials are captured below. Build everything possible without user passwords;
batch every "user-only" step at the very end (section USER STEPS). Keep building across many sessions; update this file at every milestone.

Runtime data dir: ~/Library/Application Support/MacReach/  (config.json, auth.json 0600, audit.log, helper.sock)

## Architecture (locked)
- `helper/`  Swift package -> MacReach.app (LSUIElement, own LaunchAgent, fixed path, stable code signature so TCC grants survive rebuilds).
  ScreenCaptureKit -> VideoToolbox H.264 (AVCC + avcC description, no B-frames, RealTime) | JPEG fallback; CGEvent input; NSPasteboard clipboard; power assertions;
  synthetic test-pattern source (`--test-pattern`) so pipeline is testable without Screen Recording permission.
  Listens on a Unix socket (0600). Framing: [1B type][4B BE len][payload].
- `server/`  Node (v25, only dep `ws`). 127.0.0.1 only. node:crypto argon2 (async), TOTP, sessions, rate limits, CSRF, CSP, audit log, WS bridge, file transfer over plain HTTP streams, adaptive quality controller.
- `web/`  vanilla ES modules, no build step. WebCodecs VideoDecoder -> canvas; JPEG fallback. All timing thresholds in web/js/config.js.
- `bin/macreach`  CLI: set-password, set-username, totp, status, doctor, audit, access (pause/resume tunnel), etc.
- `scripts/`  build/sign/install LaunchAgents, tailscale setup.
- Single controlling session at a time (takeover prompt). Helper only streams while a client is attached; sends nothing when screen static.

## Key rules / gotchas (from design review)
- Backpressure: client acks frames by seq; server derives RTT/throughput; never drop P-frames silently — drop-to-next-IDR (request keyframe) + lower bitrate/fps/res. Client decodes all, renders latest only.
- ws perMessageDeflate OFF. Async argon2. Rate-limit BEFORE hashing.
- Secure context needed for WebCodecs/clipboard/Secure cookies: test via http://localhost (check Safari cookie quirk -> dev flag) and Tailscale https.
- Input: dbl/triple click needs kCGMouseEventClickState; drag = leftMouseDragged; coords in display POINTS; scroll pixel units (+ natural-scroll toggle); keys -> kVK via KeyboardEvent.code, post to cghidEventTap; Mission Control via `open -a`.
- IME: hidden input w/ shadow-value diff -> backspaces + unicode insert (handles iOS, Gboard keyCode 229, dictation).
- iPad = MacIntel + maxTouchPoints>1. Pointer Events + touch-action:none. Manifest display standalone for iPhone.
- iOS clipboard: Mac->device needs user gesture; device->Mac via paste event on hidden input.
- Known limits for final card: lid closed, lock screen, pre-login after reboot = dead zones. macOS periodic Screen Recording re-prompt (research).
- No sudo/passwords during build. Do not run `macreach set-password` ever. Do not make public (Funnel) without explicit user confirmation.

## Milestones (tick when DONE+VERIFIED)
- [x] M0 PROGRESS.md + memory pointer
- [x] M1 signing identity (own keychain, self-signed) + verify designated requirement not cdhash
- [x] M2 Swift helper: UDS, test pattern, VT H.264 encode, JPEG fallback
- [~] M3 (SCK capture/input/clipboard code written, UNTESTED: needs TCC grants) Swift helper: SCK capture, input injection, clipboard, power, displays, permission status
- [x] M4 Node server: config, auth (argon2, sessions, rate-limit, lockout, CSRF, audit, TOTP+recovery), static, WS bridge, takeover, files, adaptive quality
- [~] M5 (all modules written; mouse+video e2e verified; touch/IME/clipboard/files need e2e) Web client: login, video, mouse, touch (direct/trackpad), keyboard (physical+IME+toolbar), clipboard, files, responsive UI, device detection
- [ ] M6 E2E verification (Playwright/Chrome w/ test pattern; unit tests for input mapping)
- [ ] M7 LaunchAgents (helper app + server), auto-start, `macreach` CLI installed on PATH
- [ ] M8 Tailscale: install/choose variant, Serve config prepared (login = user step), Funnel prepared (needs user OK), public-URL reachability check
- [ ] M9 doctor command + final card + USER STEPS list
- [x] M10 polish: cursor overlay, adaptive tuning, docs

## Decisions log
(append below)

## USER STEPS (to be done together at the end)
(append below as discovered)

## Decisions log
- Test harness (no real Mac perms): helper `--test-pattern --socket /tmp/mr/h.sock --input-log /tmp/mr/in.log`; server `MACREACH_DATA_DIR=/tmp/mrdata MACREACH_HELPER_SOCK=/tmp/mr/h.sock MACREACH_PORT=7879 node server/src/index.js`; test creds in /tmp/mrdata/auth.json (user test / test-password-123; made by /tmp/mkauth.mjs, throwaway, NOT the real password). Unix socket path must be <104 chars (use /tmp/mr).
- Chrome/Playwright H.264 buffers frames unless SPS has VUI bitstream_restriction (num_reorder=0): server/src/h264.js patches avcC in HelperLink. Verified: decode 1.6ms, no flush needed.
- Desktop typing: physical keys by code; on-screen-keyboard path (hidden textarea shadow diff) only when kb.osk is on.
- Session idle timeout counts input activity only (not passive viewing).
- Socket: helper accepts ONE client at a time; CLI must not connect to it (use /_ctl/* HTTP with control.token).
- Verified e2e in Playwright Chromium: login, WS, H.264 decode, mouse abs mapping, dbl/right click, wheel, key down/up.
- Hub: keys sent via `seq` are paced (6ms); any other input arriving meanwhile is queued behind them (`_pend`) so IME autocorrect (Backspaces then text) keeps order. Verified.
- server/test/e2e.test.mjs (`node --test server/test/e2e.test.mjs`): 8 pass (auth gating, headers, Host check, login/cookie flags, Origin, CSRF, files incl. traversal+upload, WS gating).
- Verified in Playwright Chromium via CDP touch: Direct mode (tap, dbl-tap, long-press right-click, long-press drag, 2-finger tap right-click, 2-finger scroll+momentum, pinch zoom), Trackpad mode (swipe, tap, tap-drag), OSK diff (autocorrect, emoji, backspace).
- Still UNVERIFIED (need real perms / devices): SCK capture, CGEvent injection, scroll direction, clipboard, iOS Safari quirks.
- Clipboard e2e verified against REAL NSPasteboard (helper flag `--real-clipboard` with `--test-pattern`): device->Mac and Mac->device incl. unicode/emoji/newline. Fixed echo loop (helper `lastText` dedupe; explicit pull always pushes). When testing, snapshot/restore the user's pasteboard (/tmp/mr/pbsnap save|restore dir).
- Hub: `_release` always sends `rel`, cancels in-flight paced `seq` and drops queued input of the departing controller; client `rel` is queued behind seq. Takeover + same-session-reload tests pass (10/10 e2e).
- TODO before ANY Tailscale exposure (advisor): Serve/Funnel requests arrive from 127.0.0.1 => audit every "loopback means local" assumption (/_ctl, Secure cookie omission on localhost Host, XFF trust, rate-limit key); move /_ctl to 0600 unix socket; log real Host/XFF empirically.
- M7 done: `macreach install` copies bin/server/web to ~/Library/Application Support/MacReach/runtime (NOT ~/Desktop: TCC), writes LaunchAgents com.macreach.server + com.macreach.helper (Aqua session, KeepAlive), symlinks ~/.local/bin/macreach. Re-run `macreach install` after any code change to redeploy. `macreach restart|logs|uninstall`. Both agents RUNNING now on 127.0.0.1:7878 with NO password set (login fails closed).
- /_ctl now served only on 0600 unix socket DATA_DIR/ctl.sock (no TCP route, no token). Secure cookie forced when proxy headers present or security.forceSecureCookies. config.paused gates all HTTP/WS (503).
- TOTP e2e (server/test/totp.test.mjs) 4 pass; tty hidden prompt pty test passes (server/test/tty.test.mjs). NEVER run `macreach set-password` (user rule) - tested prompt mechanics via src/tty.js only.
- CLI: set-password, set-username, totp enable|disable|status, status, audit, kick, revoke-all, install, uninstall, restart, logs. TODO: access pause|resume|kill, doctor, QR for TOTP.
- M8 prep done: tailscale (open-source brew formula, only variant with Funnel per tailscale.com/docs/concepts/macos-variants) installed; runs rootless as LaunchAgent com.macreach.tailscaled with `--tun=userspace-networking --socket=~/Library/Application Support/MacReach/tailscale/ts.sock`. NeedsLogin until user runs `macreach access login`. NOTE userspace mode: the Mac itself has no route to its own tailnet URL; test private URL from iPad/phone. Funnel needs HTTPS certs enabled + `funnel` nodeAttr (default policy allows members).
- CLI `macreach access status|login|serve|funnel [off]|pause|resume|kill`; funnel requires typed "go public" + password set; serve/funnel add Host to config.hosts + force Secure cookies. `macreach doctor` checks all (permissions, agents, power, tailscale, public reachability, XFF visibility).
- Unknown until Funnel is live: whether X-Forwarded-For/Host arrive intact (doctor flags all-127.0.0.1 logins).
- Added: idle refinement (400ms after last change, boosted-bitrate keyframe; verified 28KB vs 20KB normal on static test pattern, MACREACH_TEST_STATIC=N test switch), dropped-P-frame keyframe recovery, `macreach grant|card|doctor`, USER-STEPS.md. 17 server tests pass (e2e 12, totp 4, tty 1).
- JPEG fallback verified (20fps paints). Phone-width layout screenshot ok (toolbar scrolls). WebKit/iOS Safari NOT testable here (no playwright browsers) -> unverified.
- Cloudflare named tunnel fallback: cloudflared 2026.11.0 installed but NOT configured; needs a domain on Cloudflare (ask user only if Funnel proves unusable).
- Fixed: install from ~/.local/bin symlink (records repo path in runtime/.repo-path). Verified Tailscale serve source: Host preserved, X-Forwarded-For/Host/Proto SET (not appended => unspoofable), Funnel adds Tailscale-Funnel-Request. WebKit (Playwright 1.49 / WebKit 18.2) iPhone 15 + iPad Pro 11: login, cookie, H.264, per-device default mode all OK. CGInput maps via CGDisplayBounds (points). Neutral tailscale hostname (node-xxxxxx). displaySleep now confirms. Refinement skipped under 2.5 Mbps, 2x boost under 6 Mbps.
- Multi-display: helper reports every active display with a label (built-in first, then externals left to right), CGDisplayReconfigurationCallback re-resolves the wanted display on hot-plug (falls back to main, restores the choice when it returns), no crash when no display is active, new client no longer inherits the previous client's display. Client: toolbar monitor button (only when >1 display), choice saved in settings (displayId) and sent on attach. Tested with simulated 3 displays (incl. portrait, kill -USR1 on the test helper toggles unplug/replug). NOT tested on real extra monitors.
- Phone debugging over adb (Android 16, Chrome 157, Tailscale Serve URL). Findings and fixes:
  * Video froze on Android: helper repeats videoConfig with every keyframe and the client tore down the decoder each time, so hardware decoders never produced a frame. Video.configure now ignores an identical config (video.js).
  * Backspace: Gboard sends real Backspace keydown + input events; hidden textarea now has 32 zero-width pad chars so Backspace never hits an empty field, plus a beforeinput fallback.
  * Auto quality never left 'saver' on a mostly static screen (climb required 50% budget use): added idle climb with backoff, and in-flight frame limit now scales with measured path delay (150 ms phone path was read as congestion). Unit tests: server/test/quality.test.mjs.
  * Server: ws input is ignored for self-view (browser on the Mac itself, direct localhost) until the user opts in.
  * Bug: WEB_DIR used URL pathname, so the runtime copy under "Application Support" (space) served 404; fixed with fileURLToPath.
  * Test hygiene: never run key/txt tests against the live Mac while the user is at it; keystrokes go to the focused app, not to a probe window that is not frontmost.

## 2026-11-17: menu bar app, settings, setup assistant, installer, icon

- Helper (Swift, `StatusItem.swift`, `Windows.swift`, `AppSupport.swift`, `UIKit.swift`): menu bar item (monitor icon; red "In use" while a remote session controls the Mac, "Local" for the Mac's own browser, pause/warning symbols), menu (Disconnect, Pause/Resume, Sign out all devices, private link, permission grants, Settings, Setup assistant, Stop until next login), Settings window, first-run Setup assistant (polls permissions every 2 s using a fresh `--status` process; relaunches itself via KeepAlive when Screen Recording is newly granted). UI is only created when not `--test-pattern` and no custom `--socket`, so test helpers never add a second icon.
- State push: `Hub.pushSession()` sends `{c:'session',...}` to the helper from `_activate`, `_release`, ctl reload and on every helper reconnect. Helper resets to idle on server disconnect. Session-start notification is posted by the helper (reads "MacReach"), rate limited to one per device per 5 min.
- Every change goes through the CLI (single owner of pause/funnel/config logic). New CLI: `info` (JSON), `config set`, `autostart`, `stop`, `uninstall [--purge]`, `access login --open`, `access funnel --confirm`. Passwords/2FA only via a Terminal `.command` file (no Automation prompt, no GUI password field). Funnel on from the menu needs the typed phrase "go public" in a modal.
- `install` now stops the server, copies to a staging dir and swaps (fixes the ENOENT race), and gives the helper agent a PATH. Logs rotate (>5 MB, hourly, keep last 1 MB as .log.1). `pause`/`resume` work without Tailscale installed.
- `install.sh`: checks macOS 14+, CLT/Swift 6, Node 20+, installs ws + Tailscale, builds, signs, installs, opens the assistant. Re-run is a no-op for done steps (re-run verified on this Mac).
- Icon: `scripts/make-icons.swift` draws AppIcon.iconset (+ web PWA icons); `build-helper.sh` packs AppIcon.icns before codesign. NOTE: I overwrote the previous `make-icons.swift` (it produced the web icon-*.png) without reading it first; web icons were regenerated in the new style. Designated requirement unchanged, TCC grants survived.
- Web: key events with empty `code` are ignored (Android IME).
- `doctor` warns when the Tailscale node key expires in < 30 days (currently 180; recommend Disable key expiry).
- Tests: 24/24 (new `session-push.test.mjs`).
- Verified: menu bar item visible with "In use" while the phone was connected; install idempotent; doctor clean. NOT verified: opening the menu/Settings/Setup windows by clicking (not clicking the live Mac); fresh-Mac install (would risk this Mac's grants); notification banner; Setup window placement fix on the 3-display setup.

### Later 2026-11-17
- Advisor fixes: pause label/action use the server-pushed state; `stop` boots out the helper last; `install` runs `launchctl enable` before bootstrap (autostart off no longer breaks reinstall); helper requests notification permission at first launch and all permission prompts when the assistant first opens; windows size to content; opening MacReach.app again opens Settings; build uses a scratch path outside the repo (`~/Library/Caches/MacReach/build`). KeepAlive is unconditional so `exit(0)` relaunch works; log files are O_APPEND so in-place truncation is safe.
- BUG found and fixed: `macreach access pause/funnel off/kill` ran `tailscale funnel reset`, which wipes the private Serve link too (and can hang waiting for a browser step). Now Funnel is only touched when it is on, never `funnel reset`, and every tailscale call has a 20 s timeout. The private link was restored with `macreach access serve`.
- Verified by screenshot of the real windows: Setup assistant and Settings render fully. State at end: remote access is PAUSED (someone ran `access pause` at 17:21 local, probably from the new menu); I did not resume it.

### Funnel latency work (2026-11-17, evening)
- Phone over Funnel reconnected every ~2.5 s: the server dropped any client that did not answer a 0.5 s ping before the next one, and over Funnel the pong waits behind queued video. Now any message counts as alive, ping every 5 s, drop after 25 s of silence (`hub.js`, test in `session-push.test.mjs`).
- Quality controller (`quality.js`): the in-flight byte budget is time-based (acked rate x (rttMin + 150 ms)), floored at ~1.25 recent keyframes and at 64 KB, assumes the level's target rate while the link has been calm for 3 s; keyframe requests wait until the queue is half drained; idle climb out of the two lowest rungs after 8 s; frame cap 20. A first version without the keyframe floor starved the stream (every delta dropped behind a keyframe, level stepped down): the sim test "a link that can carry the level keeps it" covers it. Link simulator in `quality.test.mjs`: worst send-to-ack on a 1.5 Mbps / 400 ms link 5.2 s -> 0.7 s.
- A refreshed session resumes at the level it had settled at (`Hub._levels`, 10 min, only in auto mode).
- Web: stage shows the browser's own pointer when the smoothed round trip is over 120 ms (mouse/trackpad only; touch already has the local marker).
- Measured on this Mac: nearest Tailscale relay Mumbai 37 ms; the Funnel ingress nodes are in Europe (Paris/London, reached via DERP, `tailscale ping` ~145 ms, no direct path). So ~145 ms of the ~330 ms Funnel round trip is the ingress-to-Mac leg, before the phone's own network. A relay near the Mac (small VPS in Mumbai) is the only no-Tailscale-app way to cut that; not built, would need the owner's decision (public exposure, cost).
- Helper: Dock icon while a window is open, main menu (Edit for copy/paste, Cmd+W), Cmd+Q / Dock Quit go through the confirmed "Quit MacReach" (a plain exit is restarted by launchd). Add-device list hides `funnel-ingress-node` peers.
- Not verified: the phone numbers after the keyframe-floor change (adb dropped before the re-measure), Dock icon disappearing after the window closes, Cmd+Q dialog.
- Phone recording over Funnel (45 s while opening windows): level stayed 0; a ~3.5 s stall (client round trip 497 ms, probably the mobile link) was followed by six 85 KB keyframes in 3 s, i.e. a keyframe storm: each scene-change delta was dropped for exceeding the byte budget, which forced another keyframe. Fix: keyframe requests back off (400 ms doubling to 3.2 s while requests come within 5 s of each other), and while calm the budget floor is 2 x keyframe size (1.25 x after a drop). Sim test "a window opening does not start a keyframe storm": 13 keyframes before, 5 after.

### Disk image (2026-11-17, night)
- `scripts/make-dmg.sh` -> `dist/MacReach-1.0.0-arm64.dmg` (54 MB; app 157 MB: Node v24.22.3 117 MB pinned by SHA-256, Tailscale 1.104.7 38 MB copied from Homebrew after an `otool -L` check, helper, server, web). Node 24.7+ is required for `crypto.argon2`. Nested programs live in Contents/MacOS, are signed individually then the app (no hardened runtime). Same signing identity as the dev install, so the designated requirement (and macOS permission grants) match.
- Bundled mode in `bin/macreach` (`BUNDLE` detected from the script path): node/tailscale/tailscaled/helper paths come from the app, `install` writes the three LaunchAgents pointing into the app (no runtime copy), all three get `AssociatedBundleIdentifiers` so Login Items says MacReach, `~/.local/bin/macreach` is a shell wrapper, `installed.json` records app path + version.
- Helper: opened from Finder (not by launchd) and not installed for this path/version or jobs not loaded -> refuses from /Volumes or AppTranslocation, strips quarantine from itself, runs `install`, exits; launchd's copy shows Setup. Menu: Uninstall MacReach… (CLI boots out server/tailscaled, moves the app to the Trash, the helper last).
- Verified without touching the live install: image verifies and mounts, `codesign --verify --deep --strict` passes on a copy from the image, a simulated quarantine makes `spctl` reject it and stripping it keeps the signature valid, the bundled CLI + bundled Tailscale binary report the live state (`info`, `doctor`).
- NOT verified: running the downloaded Node binary (the harness refused to execute it, so argon2 and the test suite have not been run with it), the Finder-launch install handoff, uninstall, update-in-place, a fresh user on another account.
