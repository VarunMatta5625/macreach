# Changelog

## Unreleased

- Setup assistant and Settings show Tailscale sign-in, MagicDNS/HTTPS certificates, private link and key-expiry state, and can be reopened any time from the menu.
- "Add phone or tablet" window: app-store links, QR code of the private link, tailnet device list.
- `macreach://settings|setup|add-device` deep links; single running instance.
- Quality: probes the two lowest rungs after 8 s instead of 15 s, allows up to 20 frames in flight on slow relay paths (Funnel), and a refreshed session resumes at the level it had earned.
- Fixed: reconnect loop over Funnel (liveness deadline was 500 ms, now 25 s).
- Fixed: pause/kill no longer run `tailscale funnel reset` (it wiped the private link).

## 1.0.0

First complete release.

- Screen capture (ScreenCaptureKit) with hardware H.264 over WebSocket, JPEG fallback, adaptive quality, still-screen refinement.
- Mouse, touch, keyboard (with Android/iOS IME handling), scroll, clipboard sync, file transfer, multi-display with hot-plug.
- Argon2id login, sessions, CSRF/CSP/Host/Origin checks, rate limits, single controller with takeover, audit log, optional TOTP.
- Tailscale Serve (private) and Funnel (public, typed confirmation); pause and kill switches.
- Menu bar app: live "In use" indicator, menu, Settings window, first-run Setup assistant, notifications, app icon.
- `install.sh` one-shot installer; auto-start at login; log rotation; clean `uninstall [--purge]`.
- `macreach doctor` health check including Tailscale key expiry.
