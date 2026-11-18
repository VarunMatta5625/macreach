<div align="center">

<img src="docs/images/banner.svg" alt="MacReach: your Mac, in any browser, private over Tailscale" width="100%">

<br>

[![Release](https://img.shields.io/github/v/release/VarunMatta5625/macreach?style=flat-square&color=0a84ff)](https://github.com/VarunMatta5625/macreach/releases/latest)
![macOS 14+](https://img.shields.io/badge/macOS-14%2B-000?style=flat-square&logo=apple&logoColor=white)
![Apple Silicon DMG](https://img.shields.io/badge/disk%20image-Apple%20Silicon-30d158?style=flat-square)
![One npm dependency](https://img.shields.io/badge/npm%20dependencies-1%20(ws)-ff9f0a?style=flat-square)
![Tests](https://img.shields.io/badge/server%20tests-32%20passing-30d158?style=flat-square)

MacReach lets you control your own Mac from a phone, tablet or another computer, using only a web browser on that device.<br>
It streams your Mac's screen with hardware H.264 video and passes your touch, mouse, keyboard and clipboard input back, and it also supports browsing and transferring files.<br>
It runs privately over your own Tailscale network by default, with password sign-in and a visible "in use" indicator on the Mac. Public access is a separate opt-in.

<img src="docs/images/demo.gif" alt="Demo: sign in from a browser, see the Mac live, move the pointer by touch, type with the phone keyboard, check the stream statistics and browse files" width="80%">

<sub>Recorded against MacReach's built-in test pattern, so no real desktop appears. The green dot and the text lines are the Mac's received input.</sub>

[Setup](#setup) · [Why I built this](#why-i-built-this) · [At a glance](#at-a-glance) · [Using it](#using-it) · [How it works](#how-it-works) · [Interesting engineering](#interesting-engineering) · [Security](#security) · [Docs](#documentation-map)

> [!NOTE]
> **Status:** personal project, works for me, issues welcome but no promises.

</div>

---

## Setup

From download to controlling your Mac: install, run the Setup assistant, sign in from your phone.

### 1. Install

There are two ways in. The disk image is for almost everyone.

#### Option A: the disk image (no developer tools)

1. Download `MacReach-<version>-arm64.dmg` from the [latest release](https://github.com/VarunMatta5625/macreach/releases/latest). It is about 54 MB and carries its own Node.js and Tailscale.
2. Open it, drag **MacReach** into **Applications**, eject the image, then open MacReach.
3. macOS blocks the first launch because the app is **not notarized** (that needs a paid Apple developer account). This happens once:

<p align="center">
  <img src="docs/images/gatekeeper.svg" alt="Three steps: macOS blocks the launch, click Open Anyway in System Settings, open MacReach again" width="100%">
</p>

   Terminal alternative: `xattr -dr com.apple.quarantine /Applications/MacReach.app`.
4. The **Setup assistant** opens. Follow it ([step 2](#2-run-the-setup-assistant)).

**Requirements:** an Apple Silicon Mac (M1 or later) on macOS 14 or newer.

<details>
<summary><b>Updating, removing, firewall prompt, building the image yourself</b></summary>

- **Update:** download the new image, drag the app over the old one, open it once. It re-registers its background jobs by itself.
- **Remove:** menu bar icon > **Uninstall MacReach…**. It moves the app to the Trash and keeps your password and settings so a reinstall picks up where you left off. `macreach uninstall --purge` deletes those too.
- **Firewall:** with the macOS firewall on, the first start may ask whether `tailscaled` may accept incoming connections. Click **Allow**. If you click Deny, Tailscale still works through its relay servers, only slower.
- **Build the image yourself:** [docs/RELEASING.md](docs/RELEASING.md).

</details>

#### Option B: build from source (Apple Silicon or Intel)

You need macOS 14+, Xcode Command Line Tools with **Swift 6**, and **Node.js 24.7 or newer** (the server uses `crypto.argon2`, which first shipped in Node 24.7). Tailscale is optional and is installed with Homebrew.

```sh
git clone https://github.com/VarunMatta5625/macreach.git
cd macreach
./install.sh              # add --no-tailscale to skip Tailscale (then MacReach only works on this Mac)
```

`install.sh` is safe to re-run: every step that is already done is skipped. It checks your tools, installs `ws` and Tailscale, builds and signs the app, starts the three background jobs and opens the Setup assistant.

### 2. Run the Setup assistant

About ten minutes, start to finish.

```mermaid
flowchart TD
    A([Open MacReach]) --> B["1. Grant Screen Recording<br/>and Accessibility"]
    B --> C["2. Set a password<br/>(Terminal opens)"]
    C --> D["3. Sign in to Tailscale<br/>on the Mac"]
    D --> E["4. Turn on MagicDNS and<br/>HTTPS certificates (once)"]
    E --> F["5. Set up the private link<br/>and disable key expiry"]
    F --> G["6. Add a phone or tablet:<br/>Tailscale app, QR code, sign in"]
    G --> H([You are controlling your Mac])
    style A fill:#0a84ff,color:#fff,stroke:none
    style H fill:#30d158,color:#0b1220,stroke:none
```

The Setup assistant shows live ticks for every step, so you always see what is left:

<p align="center">
  <img src="docs/images/setup-assistant.png" alt="The Setup assistant with numbered callouts for each row" width="100%">
</p>

Then press **Add a phone or tablet…** and follow the four steps in that window:

<p align="center">
  <img src="docs/images/add-device.png" alt="The Add a phone or tablet window with numbered steps and a QR code" width="100%">
</p>

### 3. Sign in from your phone

Open the private link (the QR code does this), then sign in with the MacReach username and password you set in step 2:

<p align="center">
  <img src="docs/images/web-login.png" alt="The MacReach sign-in page with numbered callouts" width="100%">
</p>

Every step, with checks and fixes, is in the [setup guide](docs/SETUP.md).

> [!IMPORTANT]
> **Turn off key expiry for this Mac** in Tailscale's admin page (machine menu > Disable key expiry). Otherwise Tailscale signs it out after 180 days and your link stops working. `macreach doctor` warns when fewer than 30 days remain.

## Why I built this

I usually leave my Mac running while it works on something, and then I need to get at it from somewhere else: to check on what it is doing, grab a file, or fix a small thing without walking back to it. I wanted that to work from whatever device I had in my hand, with nothing to install on that device.

That set the rules the project follows:

- **A browser is the only client.** No app on the phone, tablet or other computer.
- **Private by default.** The server listens on `127.0.0.1` only, and [Tailscale](https://tailscale.com) is the only way in. Public access is a separate, deliberate opt-in.
- **The Mac stays usable.** It stays awake during a session, the menu bar icon turns red while someone is in, and a pause switch and a kill switch are always one command away.
- **Small enough to understand.** A native helper, a small Node server with one dependency, and a web client with no build step.

It is a personal tool first. I keep it on GitHub as a project to show how it is built, and in case it is useful to someone else. It works for me; issues are welcome, but there are no promises.

## At a glance

A small native menu bar app captures your screen and injects mouse, keyboard and clipboard input. A tiny Node server (one dependency, [`ws`](https://github.com/websockets/ws)) streams hardware H.264 over a WebSocket to a plain JavaScript web client. [Tailscale](https://tailscale.com) carries it: **private to your own devices by default, public only if you explicitly turn it on.**

```mermaid
flowchart LR
    P["Phone, tablet or computer<br/>any modern browser"] -- "HTTPS + WebSocket" --> T{{"Tailscale<br/>Serve (private)<br/>Funnel (public, opt-in)"}}
    T -- "127.0.0.1:7878" --> N["Node server<br/>login, sessions, quality"]
    N <-- "helper.sock<br/>H.264 / JPEG out, input in" --> H["Swift helper<br/>menu bar app"]
    H --> M[("Your Mac<br/>screen, mouse, keys,<br/>clipboard")]
    style P fill:#0a84ff,color:#fff,stroke:none
    style T fill:#5e5ce6,color:#fff,stroke:none
    style N fill:#30d158,color:#0b1220,stroke:none
    style H fill:#ff9f0a,color:#0b1220,stroke:none
    style M fill:#1c1c1e,color:#fff,stroke:#8e8e93
```

<p align="center">
  <img src="docs/images/web-gallery.png" alt="The MacReach web client on a phone held sideways: toolbar, shortcut bar, settings sheet and file browser" width="100%">
</p>

> [!NOTE]
> The screen in these screenshots is MacReach's built-in **test pattern**, used so that no real desktop appears in the documentation. On your phone you see your Mac.

## Features

| | |
| --- | --- |
| **Control** | Mouse, trackpad and touch (two touch modes), a full keyboard with a path for phone keyboards and emoji, scrolling with momentum, pinch zoom, clipboard sync (text and images), file browsing and transfer, several displays with hot-plug. |
| **Video** | ScreenCaptureKit capture, VideoToolbox hardware H.264 decoded by WebCodecs, JPEG fallback, a six-rung [quality ladder](docs/ARCHITECTURE.md#the-quality-controller) that adapts to your connection, and a sharp refinement frame when the screen goes still. |
| **Visible on the Mac** | The menu bar icon turns red with "In use" while someone controls the Mac. An optional notification says which device connected. The Mac stays awake during a session. |
| **Security** | Argon2id password typed only in your own Terminal, sessions with CSRF, CSP, Host and Origin checks, rate limits and lockout, one controller at a time, audit log, optional TOTP, a pause switch and a kill switch. See [SECURITY.md](SECURITY.md). |
| **Guided and repeatable** | A Setup assistant covers permissions, password and Tailscale. "Add phone or tablet" shows a QR code of your private link. Re-open either from the menu bar at any time. |
| **Installable web app** | Use "Add to Home Screen" on iOS or Android for a full-screen app (it appears as "Remote"). |

## Using it

### The toolbar and shortcut bar

<p align="center">
  <img src="docs/images/web-toolbar.png" alt="Annotated toolbar of the web client" width="100%">
  <br><sub>The toolbar. Every button is numbered and explained.</sub>
</p>

<p align="center">
  <img src="docs/images/web-keybar.png" alt="Annotated shortcut bar" width="100%">
  <br><sub>The shortcut bar for ⌘ combos and function keys.</sub>
</p>

### More screens

<table>
<tr>
<td width="50%"><img src="docs/images/web-tablet.png" alt="The web client on a tablet"></td>
<td width="50%"><img src="docs/images/web-desktop.png" alt="The web client on a desktop browser with the settings panel open"></td>
</tr>
<tr>
<td align="center"><sub><b>Tablet.</b> The toolbar collapses to one row.</sub></td>
<td align="center"><sub><b>Desktop browser.</b> Settings open beside the screen.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/images/web-stats.png" alt="The live stats overlay"></td>
<td width="50%"><img src="docs/images/web-takeover.png" alt="The takeover prompt when someone else is already controlling the Mac"></td>
</tr>
<tr>
<td align="center"><sub><b>Live stats.</b> Resolution, bitrate, frame rate, RTT.</sub></td>
<td align="center"><sub><b>Takeover.</b> Only one device controls at a time.</sub></td>
</tr>
</table>

Every gesture, setting and the sign-in flow are in the [web client guide](docs/WEB-CLIENT.md).

### On the Mac

Day to day, use the menu bar icon or the command line:

```sh
macreach doctor          # health check with a fix for every red line
macreach card            # your URLs and the pause / kill commands
macreach access pause    # refuse all remote access (resume with: macreach access resume)
macreach help            # everything else
```

<p align="center">
  <img src="docs/images/menu-bar.svg" alt="The four menu bar states and the menu, with the real labels" width="100%">
</p>

## How it works

Two processes on your Mac talk over a private Unix socket: the **Swift helper** (capture, encode, input, clipboard, menu bar UI) and the **Node server** (login, sessions, the web client, quality control). Tailscale puts the server on your private network. Nothing listens on a public port.

<p align="center">
  <img src="docs/images/architecture.svg" alt="Architecture: browser, Tailscale, Node server, Swift helper and the macreach CLI" width="100%">
</p>

Video has to stay responsive on a slow link, so the server never lets a queue build up. It measures the round trip and the rate the browser actually acknowledges, and caps the bytes in flight to what the path can carry in one round trip plus 150 ms:

```math
B_{\max} \;=\; \max\!\Big(B_{\text{floor}},\ \min\big(B_{\text{ceil}},\ \hat r \cdot (\mathrm{RTT}_{\min} + 0.15\,\mathrm{s})\big)\Big)
```

When a frame would exceed that budget it is dropped, the stream waits for the next keyframe, and the level steps down the ladder. When the link is calm it climbs back up.

<p align="center">
  <img src="docs/images/quality-ladder.svg" alt="The six quality levels from saver at 0.9 Mbps to native at 16 Mbps" width="100%">
</p>

The derivations, the sequence of a login and the wire format are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Interesting engineering

The parts of this project that took the most thought, each with where to find it.

| Problem | What MacReach does | Where |
| --- | --- | --- |
| **Video must feel instant on a bad link** | Latency beats smoothness. The server caps the bytes in flight to what the path carried over one round trip plus 150 ms, drops what does not fit, waits for the next keyframe and steps down a six-rung ladder. In the link simulator, on a 1.5 Mbps, 400 ms link, the worst send-to-acknowledge time fell from **5.2 s to 0.7 s**. | [`quality.js`](server/src/quality.js), [the controller](docs/ARCHITECTURE.md#the-quality-controller) |
| **Browsers hold hardware-decoded frames back** | VideoToolbox's H.264 header omits the `bitstream_restriction` field, so a browser assumes frames may be reordered and delays them. The server rewrites the header (SPS) to declare zero reordering. Frames then appear at once, about 1.6 ms to decode. | [`h264.js`](server/src/h264.js), [Video](docs/ARCHITECTURE.md#video) |
| **A still screen should be sharp and free** | Nothing is sent while the screen is static. After 400 ms of stillness the helper re-encodes the last frame as one keyframe at a boosted bitrate, so a still screen ends up crisp without costing bandwidth. | [`Streamer.swift`](helper/Sources/MacReachHelper/Streamer.swift), [Refinement](docs/ARCHITECTURE.md#refinement) |
| **Phone keyboards do not behave like keyboards** | Autocorrect, emoji and dictation edit text rather than press keys. A hidden text field mirrors what you type, and the client diffs it against the previous value to send the right Backspaces and text. Multi-key sequences are paced and other input queues behind them, so corrections keep their order. | [`keyboard.js`](web/app/js/keyboard.js), [Input path](docs/ARCHITECTURE.md#input-path) |
| **Full control of a Mac, exposed to a network** | The server only listens on loopback. Tailscale does the networking. The password is read from a terminal with echo off and stored as Argon2id. Wrong guesses are throttled before any hashing happens. One controller at a time, with an audit log. | [`SECURITY.md`](SECURITY.md) |
| **Small on purpose** | A Swift helper, a Node server with one dependency (`ws`) and a web client with no build step, about 5,000 lines in total. The CLI is the single owner of pause, Funnel, config and install logic, and the menu bar app calls it instead of repeating it. 32 tests, including the link simulator and end-to-end runs against a test-pattern helper. | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## Security

MacReach gives whoever signs in full control of your Mac, so it is private by default:

- The server listens on `127.0.0.1` only. Remote reach comes from Tailscale Serve (your tailnet) or, if you opt in, Funnel (the public internet; a visitor sees only the sign-in page until they sign in).
- The password is read only from your own Terminal, with echo off, and stored as an Argon2id hash.
- Wrong guesses are throttled before any hashing happens; eight failures from one address lock it out for 15 minutes.
- One controller at a time, and the menu bar icon turns red while a session is live.
- A pause switch, a kill switch and an audit log are always one command away.

> [!WARNING]
> Public access (Funnel) is **off by default**. Turning it on lets anyone on the internet reach your sign-in page. It requires a password and a typed `go public` confirmation, and the two-factor code is then always required if you enabled it. Read [SECURITY.md](SECURITY.md) first.

## Known limits

> [!NOTE]
> - A **locked screen, a closed lid, a sleeping Mac or the login window** cannot be controlled remotely. That is a macOS limit.
> - macOS periodically asks you to re-approve Screen Recording. If the remote screen turns black, approve the prompt on the Mac.
> - **Tested with** Chrome, Android Chrome and Playwright's WebKit (iPhone and iPad profiles). Real iOS and iPadOS Safari has **not** been tested yet.
> - The disk image is Apple Silicon only. Intel Macs can build from source.

## Development

```sh
cd server && npm ci && node --test test/*.mjs   # 32 server tests
scripts/build-helper.sh                          # build and sign ~/Applications/MacReach.app
macreach install                                 # deploy the server copy and restart the background jobs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules of the house.

## Documentation map

| Read this | When |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | You are installing and want every step with a check |
| [docs/WEB-CLIENT.md](docs/WEB-CLIENT.md) | You want to know every button, gesture and setting of the browser client |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | You want the design, the protocol and the math |
| [SECURITY.md](SECURITY.md) | You want to know what protects the Mac and how to stop access |
| [CHANGELOG.md](CHANGELOG.md) | You want to know what changed between versions |
| [docs/RELEASING.md](docs/RELEASING.md) | You build the disk image or publish a release |
| [CONTRIBUTING.md](CONTRIBUTING.md) | You want to change the code |
| [docs/DEVLOG.md](docs/DEVLOG.md) | You want the engineering history and the reasons behind decisions |
