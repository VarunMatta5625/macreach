# MacReach

Control your own Mac from any browser: phone, tablet or another computer. No client to install.

A small native menu bar app captures the screen and injects mouse, keyboard and clipboard input. A tiny Node server (one dependency, [`ws`](https://github.com/websockets/ws)) streams H.264 over WebSocket to a plain-JavaScript web client, with a JPEG fallback and adaptive quality. Remote access runs over [Tailscale](https://tailscale.com): private to your own devices by default, public only if you explicitly turn it on.

## Features

- **Control:** mouse, trackpad and touch, full keyboard (including an on-screen keyboard path for phones), scrolling, clipboard sync, file transfer, multiple displays (hot-plug aware).
- **Video:** hardware H.264 (ScreenCaptureKit + VideoToolbox, WebCodecs in the browser), JPEG fallback, congestion-based quality ladder, sharp refinement frame when the screen goes still.
- **Visible on the Mac:** menu bar icon turns red with "In use" while someone is controlling; optional notification when a device connects. Menu: Disconnect, Pause, Sign out all devices, Settings, Setup assistant, Quit.
- **Security:** Argon2id password (typed only in your own Terminal), sessions with CSRF/CSP/Host/Origin checks, rate limits and lockout, one controller at a time with takeover, audit log, optional TOTP 2FA, pause switch and kill switch. See [SECURITY.md](SECURITY.md).
- **Guided setup, repeatable:** a Setup assistant (re-openable from the menu) covers permissions, password and Tailscale; "Add phone or tablet" shows a QR code for the private link.
- **Easy install:** `./install.sh` on a new Mac, then a setup assistant asks for every macOS permission in one place.

## Requirements

- macOS 14 or newer (Apple Silicon or Intel)
- Xcode Command Line Tools with Swift 6, Node.js 20+
- Tailscale (the installer adds it with Homebrew) for access from other devices

## Quick start

```sh
git clone <this repo> && cd macoanywhere
./install.sh
```

Follow the Setup assistant that opens: grant Screen Recording and Accessibility, set a password (opens Terminal), optionally sign in to Tailscale and set up the private link. Full walkthrough: [docs/SETUP.md](docs/SETUP.md).

Day to day, use the menu bar icon or the CLI:

```sh
macreach doctor          # health check
macreach card            # URLs and pause/kill commands
macreach access pause    # refuse all remote access (resume with: macreach access resume)
macreach help            # everything else
```

## How it works

Two processes on your Mac talk over a private Unix socket: the Swift helper (capture, input, clipboard, menu bar UI) and the Node server (auth, sessions, web client, quality control). Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limits

A locked screen, closed lid, sleeping Mac or the login window cannot be controlled remotely (a macOS limit). macOS periodically asks you to re-approve Screen Recording. Tested with Chrome, Android Chrome and Playwright WebKit; real iOS/iPadOS Safari has not been tested yet.

## Development

```sh
cd server && node --test test/*.mjs     # server tests
scripts/build-helper.sh                 # build + sign ~/Applications/MacReach.app
macreach install                        # deploy the server copy and (re)start the agents
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md) and the engineering log in [docs/DEVLOG.md](docs/DEVLOG.md).
