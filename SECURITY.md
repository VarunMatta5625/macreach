# Security

MacReach gives whoever signs in full control of your Mac, so it is built to be private by default.

## Two-factor code and the private link

The TOTP code is only requested when a login cannot prove it came over your tailnet. Tailscale Serve removes any client-supplied `Tailscale-User-*` header and adds its own only for tailnet traffic; public Funnel traffic carries none and is marked `Tailscale-Funnel-Request`, so Funnel and local logins always need the code. The password is always required. A tailnet login by someone you shared the Mac with counts as tailnet. Turn the exemption off with `macreach config set totpOnTailnet true`.

## Design

- The web server listens on `127.0.0.1` only. Remote reach comes from Tailscale Serve (your tailnet) or, if you opt in, Funnel (public internet; login page only).
- Password: Argon2id hash in a 0600 file. The password is read only from the controlling terminal with echo off, never from arguments, environment, pipes or any GUI.
- Sessions: HttpOnly, SameSite cookies (Secure behind HTTPS), absolute and idle timeouts, CSRF tokens, strict CSP, Host and Origin checks on HTTP and WebSocket.
- Brute force: rate limits before hashing, per-IP and global lockout with a Mac notification.
- One controller at a time; new devices can take over only if allowed in Settings.
- Optional TOTP 2FA with single-use recovery codes.
- Control API (`pause`, `kick`, `revoke-all`) is served only on a 0600 Unix socket, never on the TCP port.
- Audit log of logins, control start/end, access changes and config changes.
- Public access (Funnel) requires typing `go public`, and is refused when no password is set.
- A browser on the Mac itself ("self view") cannot inject input unless you opt in.

## Stopping access

| Action | How |
| --- | --- |
| Disconnect the current session | menu bar > Disconnect session, or `macreach kick` |
| Pause everything (reversible) | menu bar > Pause, or `macreach access pause` |
| Sign out every device | menu bar > Sign out all devices, or `macreach revoke-all` |
| Turn public access off | `macreach access funnel off` |
| Kill everything | `macreach access kill` |
| Away from the Mac | Tailscale admin console > Machines > disable Funnel or remove the machine |

## Things to know

- The Tailscale machine name appears in public certificate transparency logs; MacReach picks a neutral random name.
- Tailscale node keys expire after 180 days; disable key expiry for this machine so the link keeps working.
- The helper is signed with a self-signed certificate kept in a dedicated keychain so macOS permission grants survive rebuilds. It is not notarized.

## Reporting a vulnerability

Open a private security advisory on this repository (Security tab > Report a vulnerability), or contact the maintainer directly. Please do not file public issues for vulnerabilities.
