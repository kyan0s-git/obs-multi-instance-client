# OBS Fleet

A control surface for running **several OBS Studio instances at once**, built for
broadcast and production teams: ISO recording rigs, multi-destination streaming,
redundant encoders, and multi-operator setups where one machine drives more than
one OBS.

OBS Fleet does not replace OBS. It creates and manages isolated OBS
configurations, launches them together, watches their health, keeps their
profiles and scene collections in sync, and gives you one screen to drive all of
them from.

---

## What it does

**Instances.** Create an instance and you get a folder with its own OBS
configuration, its own recording directory, and its own control port. Create
twelve and they run side by side without touching each other's settings. Clone
an existing instance, seed a new one from your current OBS setup, or scan a
workspace folder to re-adopt instances moved from another machine.

**Launch.** Start one instance or the whole fleet in order, with a configurable
stagger between launches. Every launch flag OBS supports is exposed — profile,
scene collection, starting scene, studio mode, auto-record, safe mode — and the
exact command line is inspectable before you run it.

**Mass update.** Change any instance setting across a selection in one pass —
the OBS installation they run from, launch flags, starting profile and scene
collection, roles and colours. Only the fields you tick are written, so
retargeting twelve instances at a new OBS build does not also flatten the flags
each of them was set up with. Every run is previewed first: which instance
changes what, which ones already match, and which will be re-provisioned.

**Multiview.** Watch every instance's program output in one grid, and drive them
from the same screen: switch scenes, toggle source visibility, ride the audio
mixer, start and stop recording and streaming, take a studio-mode transition.

**Window layout.** When you need the real OBS interface rather than a preview,
arrange the actual OBS windows in a grid, columns, rows, main-and-stack or
cascade — across as many monitors as the rig has. Choose which displays to
use and how instances are spread over them; each display can run its own
layout, pick its own large pane, and tile under the taskbar or not. The whole
arrangement saves as the workspace default, because a monitor layout belongs
to the rig rather than to a session.

**Telemetry.** FPS, frame render time, render and encoder frame drops, CPU and
memory per instance, live bitrate, data written, disk headroom and stream
congestion — sampled continuously, charted over time, and turned into a health
verdict per instance. Host CPU, memory, GPU utilisation and VRAM sit alongside
them, because on a multi-instance rig the machine is usually the bottleneck.

**Sync.** Copy profiles, scene collections and the window/dock arrangement from
one instance to any number of others, with a consistency matrix showing which
instances are actually running the same content. Copies are rewritten on the way
in so each instance records to its own folder and no stream key is duplicated by
accident.

**Shared assets.** Attach any folder — a b-roll archive, a logo pack, a font
library — and it is published to every instance over loopback HTTP, with byte
ranges so media sources can seek. The workspace's own asset folder gets live
reload on top: edit an overlay and every browser source showing it refreshes.
One HTML file can render differently per instance, and a browser source can be
pushed into any subset of the fleet in one action.

**Import and export.** Pack profiles, scene collections, window layouts and the
asset library into a single zip, hand it to a colleague or archive it with the
show, and import it back into any instance. Importing runs through the same
rewrites as a sync, so a restored profile still records to the right folder.

---

## Versioning

Releases are SemVer with build metadata: `0.2.0+0828.03620f3` — version, then
the build date as MMDD and the commit it came from. The metadata segment is
after the `+` deliberately, since SemVer excludes it from precedence: two builds
of `0.2.0` are the same release, while a log or a bug report still names the
exact tree. The full string is in **Settings → About** and on the first line of
every session log.

Releases are cut by the **Release** workflow, which runs the full verification
gate, packages installers for Windows, macOS and Linux, creates the annotated
tag and publishes the release with those installers attached:

```bash
gh workflow run release.yml -f version=0.2.0    # or run it from the Actions tab
```

Pushing a `v*` tag by hand takes the same path. The workflow refuses to run if
the requested version disagrees with `package.json`, since the version is
compiled into the bundles and a mismatch would ship installers that misreport
themselves. Installers are unsigned.

---

## Requirements

- OBS Studio 30.2 or newer (obs-websocket 5.x is bundled with it)
- Node.js 20+ to build from source
- Windows 10/11, macOS 12+, or a Linux desktop

---

## Getting started

```bash
npm install
npm run dev
```

On first run OBS Fleet looks for an OBS installation, creates a workspace under
`~/OBS Fleet`, and starts the asset server. Then:

1. **Settings** — confirm the detected OBS installation, or add one manually.
2. **Instances → New instance** — name it, choose how many, and pick what to
   seed from (empty, your existing OBS config, or a copy of another instance).
3. **Dashboard → Launch all** — the fleet starts in order.

To build a distributable:

```bash
npm run dist          # for the current platform
npm run dist:win      # or :mac / :linux
```

---

## How instances are isolated

This is the part that decides whether multi-instance works at all, so it is
worth understanding. OBS resolves its configuration directory differently on
each platform, and OBS Fleet uses whichever mechanism that platform actually
supports.

| Platform | Strategy | Mechanism |
| --- | --- | --- |
| Windows | Portable (linked) — *default* | Directory junctions to `bin`, `data` and `obs-plugins` in the real install, plus `--portable`. Costs almost no disk space and needs no administrator rights. |
| Windows | Portable (full copy) | A complete copy of the OBS installation per instance. Uses several hundred MB each, but survives the base install being upgraded or removed. |
| macOS | Redirected `HOME` | The shared app bundle is launched with a per-instance `HOME`, which is where macOS builds look for Application Support. |
| Linux | `XDG_CONFIG_HOME` | The shared binary is launched with a per-instance `XDG_CONFIG_HOME`, which is what libobs reads. |

The Windows installer is the assisted kind rather than one-click, so it asks
where to install. It installs for the current user by default and offers an
all-users install. Where the *instances* live is separate and set in
**Settings → workspace root**; it defaults to `~/OBS Fleet` and can be any
folder, including another drive.

Portable mode is only compiled into Windows builds of OBS (`ENABLE_PORTABLE_CONFIG`
is off in the official macOS and Linux builds), which is why the environment
variable approach is used on those platforms rather than `--portable`.

Every instance is launched with `--multi`, which is what stops OBS showing the
"OBS is already running" dialog for each instance after the first.

An instance folder looks like this:

```
<workspace>/instances/<name>/
  instance.json           metadata marker
  obs/                    Windows only: junction farm or copy of the install
    bin/  data/  obs-plugins/
    config/obs-studio/    portable OBS configuration
  config/obs-studio/      Linux/macOS: configuration reached via the environment
  recordings/             this instance's recording output
  assets/                 per-instance local files
```

---

## Control connection

Each instance gets a unique obs-websocket port (from `basePort`, default 4456)
and its own randomly generated password. Both are written into the instance's
`plugin_config/obs-websocket/config.json` and passed on the command line —
the CLI flags alone cannot *enable* a disabled server, so the config file has to
be right before the first launch.

Ports bind to loopback only. Nothing OBS Fleet runs is reachable from the
network.

---

## A few deliberate behaviours

**Quitting the client leaves the instances running.** A production team's
instances are frequently on air, and closing a control surface must never take
the show down. On the next start, OBS Fleet probes each instance's port,
reconnects to whatever is still up, and resolves its process so it can still be
stopped cleanly.

**Bulk launches are staggered, bulk transport actions are simultaneous.**
Several OBS instances initialising a GPU encoder at the same instant routinely
fail with "failed to start encoder", so launches are serialised. Pressing record
across eight ISO instances, on the other hand, should land within a frame of
each other, so those go out in parallel.

**Frame-drop health is measured over a window, not a lifetime.** A show that
dropped 400 frames an hour ago is healthy now; lifetime ratios would keep it red
for the rest of the session.

**Sync repoints recording output.** Copying a profile to five instances without
rewriting its output path would have all five recording into the same directory
with the same filename pattern, overwriting each other's takes. That rewrite is
on by default, along with clearing stream keys and regenerating source UUIDs.

**"Identical" means identical content, not identical bytes.** The consistency
matrix compares a canonical form with the per-instance fields (recording paths,
display names, UUIDs, stream keys) excluded, so two instances running the same
show compare equal even though their files necessarily differ.

**Killing an instance is a last resort.** Stop asks OBS to close cleanly and
only escalates after a timeout, because a killed OBS leaves its log unterminated
and greets you with the Safe Mode prompt on the next launch.

---

## Shared assets

Files in `<workspace>/assets/` are served at `http://127.0.0.1:4599`. Serving
over HTTP rather than referencing `file://` is what makes query strings, live
reload and per-instance variation work inside OBS's embedded browser.

**Attached folders.** Point the fleet at folders you already have rather than
copying them into the workspace — a media archive can be hundreds of gigabytes,
and every instance can reach the same one over loopback without a second copy.
Attached folders appear under `/m/<id>/` and are served read-only.

Video and audio are served with HTTP range support, so an OBS media source can
seek without restarting the transfer. Media also gets a real cache policy;
overlays deliberately do not, because they are edited live.

Live reload is on for the workspace folder and off by default for attached
folders — recursively watching a large media library costs file handles for
files that rarely change, and you can turn it on per folder.

Every served HTML page gets two things injected:

```js
// Which instance is rendering this page
window.OBSFleet = { instance, instanceId, role, color }
```

...and a live-reload client, so editing the file on disk refreshes every browser
source showing it.

The whole fleet is also discoverable from an overlay:

```js
const { instances } = await (await fetch('/__fleet/instances.json')).json()
const { mounts } = await (await fetch('/__fleet/mounts.json')).json()

// Resolve a file in an attached folder without hardcoding its prefix:
img.src = OBSFleet.asset('media:stings/open.webm')
```

which is enough to build a tally wall or a fleet-wide status overlay from a
single file.

## Bundles

**Sync → Export bundle** packs the fleet's configuration into an ordinary zip:

```
manifest.json
sources/<instance>/profiles/<name>/basic.ini
sources/<instance>/scenes/<name>.json
sources/<instance>/ui-layout.json
assets/...                      (optional)
```

Any zip tool can open it, and the contents are recognisable OBS files rather
than an opaque blob. Importing stages the bundle into a temporary folder shaped
like an instance and then runs the ordinary sync pipeline over it, so an
imported profile gets the same per-instance rewrites — and the same reviewable
plan and automatic backups — as one copied between two local instances.

---

## Window layout

OBS Fleet drives your window manager rather than trying to reparent OBS windows
into itself. Embedding another process's top-level window is fragile on every
platform and breaks OBS's own previews and dialogs; driving the window manager
keeps every OBS window fully interactive.

- **Windows** — PowerShell and the Win32 window API. No extra setup.
- **macOS** — AppleScript. macOS asks for Accessibility permission the first
  time a window is moved.
- **Linux** — `wmctrl` (`sudo apt install wmctrl`). X11 only; wmctrl does not
  work under Wayland.

---

## Performance notes

A twelve-instance fleet is a lot of polling, so a few things are deliberate:

- **Digests are cached by size and mtime.** The consistency matrix hashes every
  profile and scene collection of every instance on each refresh. Caching makes
  a re-read cost one `stat` per file instead of reading the bytes: measured on a
  twelve-instance tree, a warm pass holds flat at ~8 ms while a cold pass grows
  with content — 3.7× faster with 50 KB scene collections, 9.6× with 2 MB ones.
- **One walk, not two.** Digest and folder size come from the same traversal.
- **Preview frames are batched and de-duplicated.** Captures are emitted once
  per tick rather than once per instance, and a frame identical to the last one
  sent is dropped — a static scene encodes to the same JPEG every time.
- **Renderer updates are coalesced.** Telemetry, previews, runtime and log
  events arriving in one tick produce a single React render, and log lines are
  buffered before they reach the store.
- **OBS output is rate limited** per instance (configurable), because an OBS
  launched with `--verbose` can emit thousands of lines a second. Lines that
  look like faults are never dropped.
- **Expensive host probes are throttled.** `nvidia-smi` and volume enumeration
  do not run on every tick, and overlapping samples are skipped rather than
  stacked.
- **Asset listings are cached per folder** and invalidated by the watcher, with
  a cap on how many files a single attached folder contributes.
- **Health is published only when a verdict moves.** It is recomputed every two
  seconds for the life of the session; emitting unconditionally would cost an
  IPC message and a re-render of every health consumer even with the fleet
  idle and nothing wrong.
- **Store snapshots are memoised per consumer.** Selectors are compared against
  the state they were derived from, so an event that does not touch a slice
  does not re-render the components reading it.
- **Views load as separate chunks, then are warmed at idle.** The startup
  bundle is roughly half what it would be, without a view switch ever being
  the thing that waits.

The install is trimmed too: Chromium's 55 locale packs come down to the one the
UI actually speaks, and source maps, type declarations and duplicate library
builds are kept out of the app archive — together about 40 MB.

---

## Development

```bash
npm run dev         # hot-reloading development build
npm run typecheck   # main + renderer
npm run test        # unit and filesystem integration tests
npm run build       # production build into out/
```

A headless boot check, used in CI, starts the app, loads the renderer and exits
with a status code:

```bash
OBSFLEET_SMOKE_TEST=1 xvfb-run -a npx electron --no-sandbox .
```

### Layout

```
src/
  main/           Electron main process
    services/     supervisor, launcher, provisioning, sync, telemetry, ...
    util/         ini parsing, filesystem, process and network helpers
    ipc/          typed IPC handlers
  preload/        the context-isolated bridge
  renderer/       React UI
  shared/         types and the IPC contract shared by all three
tests/            vitest suites
```

The renderer has no Node access. Every capability it has is an explicit method
on the `FleetApi` interface in `src/shared/api.ts`, implemented in
`src/main/ipc/handlers.ts` and forwarded by the preload bridge.

---

## Licence

GPL-2.0-or-later, matching OBS Studio. See [LICENSE](LICENSE).

OBS Fleet is not affiliated with or endorsed by the OBS Project.
