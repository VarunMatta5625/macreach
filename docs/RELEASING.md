# Releasing MacReach

## Build the disk image

```sh
brew install --formula tailscale      # source of the bundled Tailscale binaries (once)
scripts/make-dmg.sh                    # -> dist/MacReach-<version>-arm64.dmg and .sha256
```

The version comes from the `VERSION` file. Node is downloaded once and checked against a pinned SHA-256 (update `NODE_VERSION` and `NODE_SHA256` in `scripts/make-dmg.sh` together; it must stay at Node 24.7 or newer for `crypto.argon2`).

## Before the first public release

- **Back up the signing key** (see below). Do this before anyone else installs the app.
- **LICENSE:** add one; the repository has none.
- **Personal details:** `git grep -nIiE "<your name>|<your tailnet name>|/Users/"` and check the history too (`git log --all -S"<string>"`). The tracked files and history were checked clean on 2026-11-17.
- **Repository visibility:** a private repository's release files are only downloadable by you. Making it public, or publishing releases from a separate public repository, is a decision for the owner.
- **Try it on a second macOS user account or a virtual machine** (fresh first run: Open Anyway, permissions, password, Tailscale).

## The signing key

Everything is signed with a self-made certificate kept in `~/Library/Application Support/MacReach/signing` (valid until 2036). macOS ties its Screen Recording and Accessibility grants to that identity, so **if the key is lost, every user must grant them again after the next update**.

```sh
scripts/backup-signing-key.sh ~/Safe/MacReach-signing-backup.enc    # asks for a passphrase in your Terminal
```

Keep the backup off this Mac (a password manager attachment or an encrypted USB stick), never in git. To restore on a new Mac:

```sh
mkdir -p "$HOME/Library/Application Support/MacReach"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in MacReach-signing-backup.enc | tar -xzf - -C "$HOME/Library/Application Support/MacReach"
```

## What the image does not do

- **Apple Silicon only.** The helper, Node and Tailscale in the image are arm64. Intel Macs can still build from source (`./install.sh`).
- **No notarization** (needs a paid Apple developer account), so users go through System Settings > Privacy & Security > Open Anyway once.
- **No auto-update:** users download the new image, drag it over the old app and open it once.
- **Firewall prompt:** with the macOS firewall on, the first start can ask whether `tailscaled` may accept incoming connections. Allow it. If it is denied, Tailscale still works through its relay servers, only slower.
