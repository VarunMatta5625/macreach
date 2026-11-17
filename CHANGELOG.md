# Changelog

## 1.0.0

First complete release.

- Screen capture (ScreenCaptureKit) with hardware H.264 over WebSocket, JPEG fallback, adaptive quality, still-screen refinement.
- Mouse, touch, keyboard (with Android/iOS IME handling), scroll, clipboard sync, file transfer, multi-display with hot-plug.
- Argon2id login, sessions, CSRF/CSP/Host/Origin checks, rate limits, single controller with takeover, audit log, optional TOTP.
- Tailscale Serve (private) and Funnel (public, typed confirmation); pause and kill switches.
- Menu bar app: live "In use" indicator, menu, Settings window, first-run Setup assistant, notifications, app icon.
- `install.sh` one-shot installer; auto-start at login; log rotation; clean `uninstall [--purge]`.
- `macreach doctor` health check including Tailscale key expiry.
