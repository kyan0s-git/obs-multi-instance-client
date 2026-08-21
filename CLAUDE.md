# OBS Fleet — working notes for Claude

## Commit authorship — read this before committing

**This is a personal project. Do NOT apply the `github-commit-authorship` skill here.**

That skill mandates `Daniel Lee <danieljwlee87@gmail.com>` as primary author. It
applies **only to Silvia projects** — **Skyline**, **Supra** and **Parallax**.
Applying it to a personal repo is wrong, and has had to be undone here already.

Commits in this repo use:

```
Author / committer:  kyan0s-git <91159868+kyan0s-git@users.noreply.github.com>
Trailer:             Co-authored-by: Claude <model> <noreply@anthropic.com>
```

Concretely:

```bash
GIT_COMMITTER_NAME="kyan0s-git" \
GIT_COMMITTER_EMAIL="91159868+kyan0s-git@users.noreply.github.com" \
git commit --author="kyan0s-git <91159868+kyan0s-git@users.noreply.github.com>" -m "..."
```

Do not add a `Co-authored-by:` line for `kyan0s-git` — they are the author, so it
would be redundant.

---

## What this project is

A control surface for running several isolated OBS Studio instances at once,
aimed at broadcast and production teams. Electron + TypeScript + React. It
creates instance folders, launches them, drives them over obs-websocket, watches
their health, and keeps their profiles and scene collections in sync.

See `README.md` for the full feature description and the rationale behind the
design decisions.

## Commands

```bash
npm run dev         # hot-reloading development build
npm run typecheck   # main (tsconfig.node.json) + renderer (tsconfig.web.json)
npm test            # vitest: launch args, tiling, ini, health, sync
npm run build       # typecheck + electron-vite build into out/
npm run dist        # packaged installer for the current platform
```

Headless boot check (also used in CI) — starts the app, loads the renderer,
exits with a status code:

```bash
OBSFLEET_SMOKE_TEST=1 xvfb-run -a npx electron --no-sandbox .
```

Run this after touching anything in `src/main/index.ts`, the preload bridge, or
the IPC contract. A typecheck alone cannot show that those three still agree.

## Layout

```
src/
  main/           Electron main process
    services/     supervisor (orchestrator), launcher, provision, sync,
                  telemetry, obs-* (websocket), window-control, asset-server
    util/         ini, fsx, net, process, async, logger
    ipc/          typed handlers, checked against FleetApi
  preload/        the context-isolated bridge
  renderer/       React UI (views/ is one file per nav item)
  shared/         types.ts and api.ts — the contract all three share
tests/            vitest
```

`Supervisor` owns every service and is the only thing the IPC layer talks to.
Adding a capability means: a method on `FleetApi` (`src/shared/api.ts`), its name
in `API_METHODS`, and an implementation in `src/main/ipc/handlers.ts`. The
handler object is structurally checked against `FleetApi`, so a mismatch is a
type error rather than a runtime surprise.

## Things that are easy to break

**Instance isolation is platform-specific and non-negotiable.** OBS resolves its
config directory differently on each platform, and the wrong choice silently
makes two instances share one configuration:

- **Windows** — portable mode (`--portable`) against a junction farm. Portable
  config resolves to `<exe>/../../config`.
- **macOS** — redirected `HOME`. Portable mode is *not* available; official
  builds compile with `ENABLE_PORTABLE_CONFIG` off.
- **Linux** — `XDG_CONFIG_HOME`. Same reason.

Never offer `--portable` on macOS or Linux.

**Every launch must pass `--multi`.** Without it, OBS shows a blocking
"already running" dialog for every instance after the first.

**obs-websocket CLI flags cannot enable a disabled server.** `--websocket_port`
and `--websocket_password` only *override*. The instance's
`plugin_config/obs-websocket/config.json` must already have `server_enabled:
true` before the first launch, which `provision.ts` handles.

**Sync must repoint recording output.** Copying a profile to N instances without
rewriting its output path leaves them all recording into the same directory with
the same filename pattern, overwriting each other's takes. Covered by
`tests/sync.test.ts`.

**Sync comparison is canonical, not byte-wise.** Every copy is normalised on the
way in, so raw hashes would never match. `canonicalProfileHash` /
`canonicalCollectionHash` exclude exactly the fields sync is meant to rewrite
(recording paths, display names, UUIDs, stream keys).

**The preload is `.mjs`, not `.js`.** The package is `type: module`, so
electron-vite emits ESM, and Electron loads an ESM preload only with
`sandbox: false`. Both are set deliberately in `src/main/index.ts`.

**Quitting leaves instances running, on purpose.** Instances are frequently on
air; closing the control surface must not take the show down. Startup probes
each instance's port and re-adopts whatever is still up.

## Style

Match the surrounding code. Comments explain *why* a non-obvious choice was made
(they are load-bearing in `services/` — most encode something learned from the
OBS source), not what the line does. Numeric UI values use the `num` class for
tabular figures. No emoji as icons; `components/Icons.tsx` has inline SVG.
