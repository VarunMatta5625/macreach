# Contributing

## Layout

| Path | What |
| --- | --- |
| `helper/` | Swift package: capture, encode, input, clipboard, menu bar app, Settings, Setup assistant |
| `server/` | Node server and tests (`node --test test/*.mjs`) |
| `web/` | Browser client: vanilla ES modules, no build step |
| `bin/macreach` | CLI; the single owner of pause, funnel, config and install logic. UI code calls it instead of reimplementing |
| `scripts/` | Build, signing and icon scripts |
| `docs/` | Setup guide, architecture, development log |

## Working on it

```sh
scripts/build-helper.sh && macreach install   # rebuild the app, redeploy, restart
cd server && node --test test/*.mjs           # tests (must stay green)
macreach doctor                               # health check after changes
```

The server runs from a copy in `~/Library/Application Support/MacReach/runtime` (not the repo, because macOS privacy rules block launchd from reading `~/Desktop`), so run `macreach install` after every change.

## Rules of the house

- Secrets (passwords, TOTP secrets) are only ever typed in a terminal. Do not add GUI password fields or accept secrets via argv/env.
- Never run test input against your live Mac: use the test helper (`MacReach --test-pattern --socket /tmp/...`), which also never creates a menu bar item.
- Tests use a throwaway data dir (`MACREACH_DATA_DIR`); `macreach install` refuses to run with it set.
- Do not turn on Funnel from code or tests.
- Keep dependencies at zero beyond `ws`.
- Commit messages: short imperative subject, explain the why in the body.
