# MacReach setup guide

Everything else is built, installed and running (web server, helper app, Tailscale daemon, all start at login).
Do these in order. Each step ends with a check. About 10 minutes in total.

Run commands in Terminal. `macreach` is already on your PATH.

## 1. Grant the two macOS permissions

The MacReach icon is in your menu bar (a monitor; it turns red with "In use" while someone is controlling this Mac). On first launch its **Setup assistant** opens (menu bar icon > Setup assistant… to reopen). Press **Grant…** next to Screen Recording and Accessibility and turn MacReach **on** in the System Settings page that opens. The assistant ticks each row live and the app restarts itself once Screen Recording is on. Optionally press **Allow…** for notifications (a notice when a device connects).

Without the menu bar: `macreach grant`, then `macreach restart`.

Check: `macreach doctor` shows both permissions as `[ ok ]`.

## 2. Set your password (never share it with anyone, including Claude)

```
macreach set-password
```

You are asked for a username (first time only) and then the password twice, with no echo.
Use a long passphrase (12+ characters). It is stored only as an argon2id hash.

Optional two-factor login: `macreach totp enable` (shows a secret and 10 one-time recovery codes; save them).

Check: `macreach status` says `Password : set`.

## 3. Try it on this Mac

Open http://localhost:7878/ in a browser and sign in. Looking at your own Mac from itself works, but input is ignored there unless you opt in (otherwise your own clicks and the remote cursor fight each other). Test control from your phone or iPad instead.
Quick checks: if you have extra monitors connected, a monitor button appears in the toolbar ("Mac" = built-in, 1, 2... = external) and switches which display you see and control; your choice is remembered, unplugging a display falls back to the built-in one, and plugging it back restores it. Then: move the mouse, type, scroll (if scrolling feels reversed, flip "Invert scroll on the Mac" in the settings sheet), copy text on one side and paste on the other.

## 4. Tailscale (private access from your iPad, iPhone and other computers)

1. Install the **Tailscale app** on your iPhone and iPad (App Store) and sign in with the same account you will use below.
2. On the Mac: `macreach access login`, open the printed link, approve. The machine gets a random neutral name like `node-1a2b3c` (it appears in the public HTTPS certificate log, so avoid a revealing name; `macreach access login <name>` overrides it).
3. In the Tailscale admin console (https://login.tailscale.com/admin/dns) turn on **MagicDNS** and **HTTPS Certificates**.
4. On the Mac: `macreach access serve`. It prints your private URL.

Check: open that URL on your iPad (Tailscale on), sign in.
Note: this Mac cannot open its own tailnet URL (the Tailscale daemon runs without root, so the Mac has no route to it). Test from another device.

## 5. Public URL (only if you want it; I will not turn this on myself)

```
macreach access funnel
```

You must type `go public`. It refuses to run if no password is set. Funnel needs the Funnel permission in your tailnet policy; the default policy has it.
Then run `macreach doctor` to confirm the public URL answers and that client IPs are visible (this decides whether the per-IP rate limit works behind Funnel).

Turn it off any time: `macreach access funnel off`.

## 6. Keep the Mac reachable (needs sudo, optional)

```
sudo pmset -c sleep 0
```

(Already 0 on your Mac as last checked.) A closed lid, a sleeping Mac, the login window and a locked screen cannot be controlled remotely; that is a macOS limit.

## New Mac

```
copy this folder to the new Mac (AirDrop, USB or git), then:  cd macoanywhere && ./install.sh
```

`install.sh` checks macOS 14+, Xcode Command Line Tools (Swift 6), Node 20+, installs `ws` and Tailscale (Homebrew), builds and signs the app, starts the agents and opens the Setup assistant, which asks for every permission in one window. Safe to re-run. `./install.sh --no-tailscale` skips Tailscale.

## Starting and stopping

| Want to | Do |
| --- | --- |
| Pause / resume remote access | menu bar icon > Pause remote access, or `macreach access pause` / `resume` |
| End the current session | menu bar icon > Disconnect, or `macreach kick` |
| Stop MacReach until next login | menu bar icon > Stop MacReach until next login…, or `macreach stop` |
| Don't start at login | Settings… > uncheck "Start MacReach when I log in", or `macreach autostart off` |
| Remove completely | `macreach uninstall` (keeps your data) or `macreach uninstall --purge` |

## Keep the link the same

Your private link (`https://node-….ts.net/`) does not change by itself. It changes only if you remove or rename this Mac in the Tailscale admin console, or `macreach uninstall --purge`. One thing will break it: Tailscale expires a machine's key after 180 days. In https://login.tailscale.com/admin/machines open this machine's menu and choose **Disable key expiry**. `macreach doctor` warns when under 30 days remain.

## Day to day

| Want to | Command |
| --- | --- |
| See the access card (URLs + controls) | `macreach card` |
| Pause everything, reversible | `macreach access pause` / `macreach access resume` |
| Kill all remote access | `macreach access kill` |
| Away from the Mac | Tailscale admin console > Machines > this machine > disable Funnel or remove it |
| Who is connected | `macreach status`, `macreach audit` |
| Disconnect them / sign out all devices | `macreach kick` / `macreach revoke-all` |
| Health check | `macreach doctor` |

After updating the code in `~/Desktop/macoanywhere`, run `./install.sh` (or `scripts/build-helper.sh && macreach install`) to redeploy. Logs rotate automatically (over 5 MB, hourly check).

## Known limits

- **Locked screen, closed lid, sleep, login window:** not controllable remotely (macOS limit). Unlock the Mac once locally.
- **Periodic Screen Recording re-approval:** since macOS Sequoia, macOS re-asks every so often (about monthly) whether an app may keep recording the screen. If the remote screen turns black or `macreach doctor` shows Screen Recording as not granted, approve the prompt at the Mac. The Apple entitlement that avoids this (`persistent-content-capture`) is only granted to approved VNC-type apps, so a personal build can't use it. I could not confirm current macOS 27 behaviour; watch for it.
- **Safari-specific behaviour:** tested with Playwright's WebKit (iPhone 15 and iPad Pro 11 profiles) and Chrome, not on real iOS or iPadOS devices. Pencil hover and the iOS keyboard paths need a real device check.
- **Real screen capture and input injection** could only be tested once you grant the permissions (step 1); until then they were tested against a synthetic test screen.
