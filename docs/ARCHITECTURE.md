# Architecture

```
 browser (phone / iPad / PC)                         your Mac
┌──────────────────────────┐   HTTPS    ┌──────────────────────────────────────────────────────┐
│ web/ client              │◀──────────▶│ Tailscale Serve / Funnel (optional)                  │
│ WebCodecs → canvas       │  WebSocket │        │ 127.0.0.1:7878                              │
└──────────────────────────┘            │  ┌─────▼───────────┐  helper.sock   ┌─────────────┐  │
                                        │  │ Node server     │◀──────────────▶│ Swift helper│  │
                                        │  │ auth · sessions │  framed JSON + │ (menu bar   │  │
                                        │  │ hub · quality   │  H.264/JPEG    │  app)       │  │
                                        │  └─────▲───────────┘                └─────────────┘  │
                                        │        │ ctl.sock (0600)  ◀── macreach CLI          │
                                        └──────────────────────────────────────────────────────┘
```

## Swift helper (`helper/`)

`~/Applications/MacReach.app`, a LaunchAgent (`com.macreach.helper`, `LSUIElement`). Signed with a self-signed certificate from a dedicated keychain so macOS (TCC) permission grants survive rebuilds.

- `Capture.swift`: ScreenCaptureKit source per display, display list and hot-plug observer, synthetic test-pattern source.
- `Encoder.swift`: VideoToolbox H.264 (no B-frames, SPS patched for zero reorder) or JPEG; refinement keyframe after the screen goes still.
- `Streamer.swift`: starts/stops capture, picks and re-picks displays, backpressure-aware frame emission.
- `Input.swift`: CGEvent mouse, scroll, keys (by `KeyboardEvent.code`), unicode text.
- `System.swift`: permissions, clipboard sync, power assertions, system commands.
- `Link.swift`: Unix-socket server; frames are `[1B type][4B big-endian length][payload]` (helper→server `1` JSON, `2` video; server→helper `0x10` JSON command).
- `StatusItem.swift`, `Windows.swift`, `UIKit.swift`, `AppSupport.swift`: menu bar item, Settings, Setup assistant, notifications. UI actions call the `macreach` CLI. The UI is created only in the real installed instance, never for `--test-pattern` or a custom `--socket`.

## Node server (`server/src/`)

Dependency: `ws`. Binds `127.0.0.1` only.

- `server.js`: HTTP routes, login, CSRF/CSP/Host/Origin checks, WebSocket upgrade, control API on `ctl.sock`.
- `hub.js`: owns the single controlling session, bridges input to the helper and video to the client, pushes session state to the helper (menu bar indicator).
- `quality.js`: adaptive ladder from in-flight frames/bytes and RTT.
- `authstore.js` (credentials and sessions), `password.js`, `totp.js`, `ratelimit.js`, `audit.js`, `config.js`, `notify.js`, `tty.js`, `files.js` (transfers), `h264.js` (SPS patch), `helperLink.js` (helper socket client).

## Web client (`web/`)

Vanilla ES modules, no build step. `video.js` (WebCodecs decoder and canvas), `keyboard.js` (hidden-input shadow diff for IMEs), pointer/touch handling, settings sheet, display picker.

## CLI (`bin/macreach`)

The single owner of operational logic: install/uninstall, pause/resume/kill, Tailscale Serve/Funnel, config changes, `doctor`, `info` (JSON for the app). The server runs from a runtime copy in `~/Library/Application Support/MacReach/runtime`, deployed by `macreach install` (staged copy then swap).

## Data and logs

- `~/Library/Application Support/MacReach/`: `config.json`, `auth.json` (0600), `audit.log`, sockets, runtime copy, Tailscale state, signing keychain.
- `~/Library/Logs/MacReach/`: `server.log`, `helper.log`, `tailscaled.log` (rotated at 5 MB).
- LaunchAgents: `com.macreach.server`, `.helper`, `.tailscaled`.
