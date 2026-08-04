# BX-Viewer-Fork

> **License:** MIT License + Commons Clause
> ⚠️ **Note:** Don't commercialize it without permission!

A self-hosted, private video viewer that syncs BounceX paths to their corresponding videos, with full customization options.

## About this fork

This is a fork of [BounceX Viewer](https://github.com/Alunacoz/BounceX-Viewer) by Alunacoz — all credit for the original app, its design, and its features goes there. The fork rebuilds the app on **Next.js 16 (App Router) + TypeScript, running on Bun**, replacing the original's Python stdlib servers. Everything below describes running *this* fork; the upstream repo's install instructions do not apply here.

BounceX itself — the beat marker creation and rendering tool the `.bx` path files come from — is by Optiacku: [clbhundley/BounceX](https://github.com/clbhundley/BounceX). This project is not endorsed by or affiliated with it.

## AI Disclosure

This program was written with generative AI, with human intervention as well. I felt like it was important to be upfront with this information because I understand that it is not everyone's cup of tea.

## Features

- 🎯 Path Synchronization: Automatically syncs BounceX paths to their corresponding videos! Works when scrubbing as well!
- 🔒 Private & Self-Hosted: Completely private! Host any video you like on your own personal network!
- 🎭 Theater Mode: Unobstructed viewing experience for maximum immersion! On by default (`T` or `Esc` leaves it); turn the default off in Settings.
- 📺 Classic Overlays: Generated on the fly, with the ability to disable the background dim!
- 🔄 Y-Axis Flip: Need a different perspective? Flip the Y-axis with ease!
- 📍 Multiple Paths Per Video: Perfect for difficulty selection or different route options!
- 🎨 Color Customization: Make those paths your own with custom colors!
- 📏 Path Size Control: Adjust path thickness to your preference!
- 📦 Easy Imports: Just drag in a .zip file to add new videos!
- 📱 Cross-Device Access: Watch on any device (including mobile!) on your local network!
- 🏃 Path Speed Adjustment: Want to slow it down or speed it up? Go ahead!
- 🪄 Effects: Able to render special effects from paths created with [BX-Editor-FX](https://github.com/Alunacoz/BX-Editor-FX)!
- 🎸 DH Mode: Don't like waveforms? Automatically (but not perfectly!) convert .bx paths into simple circles in the settings!
- 🕹️ Device Output: Drive an OSSM — or any Buttplug device with positional control — straight from the `.bx` path, in sync with the video. Connects through [Intiface Central](https://intiface.com/central/) or to [OSSM Sauce](https://github.com/clbhundley/OSSM-Sauce) directly. See [docs/device-output.md](docs/device-output.md).
- 🚀 More to Come: Stay tuned for additional features and improvements!

## Example Screenshots

<img width="2555" height="620" alt="image" src="https://github.com/user-attachments/assets/457f246f-4a65-449e-bbbf-b6d26abe3fcc" />
<p align="center">The main dashboard!</p>

<img width="2554" height="1091" alt="image" src="https://github.com/user-attachments/assets/c2cbb385-d6fa-4acf-a2b1-7303c329fd66" />
<p align="center">An example video + path playing with overlay mode!</p>

<img width="2560" height="1440" alt="image" src="https://github.com/user-attachments/assets/62702bf8-1dd6-4390-ad40-14286bf1e9ce" />
<p align="center">Video + Theater mode (doesn't block the screen at all)!</p>

<img width="2559" height="1440" alt="image" src="https://github.com/user-attachments/assets/30937406-89c0-43cc-8e23-169a47f4da2a" />
<p align="center">Settings menu!</p>

<img width="859" height="1418" alt="image" src="https://github.com/user-attachments/assets/5f8f6439-1347-47eb-a817-2ed22bf51099" />
<p align="center">Manager's "add video" panel!</p>

## Requirements

**[Bun](https://bun.sh)** — that's the whole list for running the app.

`ffprobe` on your `PATH` is optional but recommended. It fills in a video's duration when `meta.json` doesn't declare one; without it those entries just show an unknown duration.

**Python is no longer required.** If you followed the original project's instructions before, you can ignore anything about installing Python 3 or creating a `venv` — the original's Python servers are gone and nothing in the app uses them. The optional `Tools/splitbx.py` helper is the sole exception; see [Tools](#tools).

## Getting Started

Clone the repo, then start it with the launcher for your platform:

| Platform | Launcher |
|---|---|
| Windows | `StartWebsite.ps1` (right-click → Run with PowerShell) |
| Windows (double-click) | `StartWebsite.bat` — just a wrapper around the `.ps1` |
| macOS / Linux | `StartWebsite.sh` |

The launcher installs dependencies if needed, starts the server, prints the LAN URL to open on other devices, and opens your browser.

### Manual

If you'd rather drive it yourself:

```sh
bun install --frozen-lockfile

# development (hot reload)
bun run dev

# production
bun run build
bun run start
```

Then open <http://localhost:8000>.

`bun.lock` is committed, and `--frozen-lockfile` installs exactly what it pins — so everyone gets the same dependency tree, rather than letting plain `bun install` quietly drift within semver ranges. The launcher and updater scripts do the same thing, falling back to a plain `bun install` only if the lockfile has drifted out of sync with `package.json`. (That plain form is also what you want when you're deliberately changing dependencies and mean to refresh the lockfile.)

### Ports

The app serves **everything on a single port** — default `8000`, set by `httpPort` in `config.json`:

```json
{
  "httpPort": 8000,
  "managerPort": 8001
}
```

The original's two-server split (content on 8000, manager on 8001) is gone. The manager is now just another page at `/manager` on the same origin, and `managerPort` is vestigial — it's kept only so old config files still parse, and changing it does nothing.

To use a different port, change `httpPort` and restart.

## Routes

| Route | What it is |
|---|---|
| `/` | Browse — grid of all videos and playlists |
| `/watch?v=<id>` | Player for a single video (`<id>` is the folder name under `videos/`) |
| `/playlist?p=<id>` | Playlist view (`<id>` is the folder name under `playlists/`) |
| `/settings` | Path colors, size, speed, DH mode, Y-flip, overlay options |
| `/about` | About page and links |
| `/manager` | Import, delete, reorder, and edit metadata for videos and playlists |

Media is served straight from disk at `/videos/<folder>/<file>` and `/playlists/<folder>/<file>` with HTTP Range support, so seeking works on large files.

## Adding content

**The easy way:** open `/manager` and drag in a `.zip`. The importer looks for any `videos/` or `playlists/` directory anywhere inside the archive and copies their child folders into place, then updates the manifests for you. Both a flat layout (`videos/Foo/`) and a wrapped one (`MyPack/videos/Foo/`) work. Folders whose name is already in the manifest are skipped rather than overwritten. Hard-refresh afterwards (`Ctrl + Shift + R`) to pick up the changes.

Everything below is what the importer produces — useful if you're building a package by hand or debugging one that won't load.

### Layout

```
videos/
  manifest.json          # ordered list of video folder names
  Drop/
    meta.json
    drop.mp4
    drop.bx
    thumb.jpg
playlists/
  manifest.json          # ordered list of playlist folder names
  BXLiteVol5/
    meta.json
    thumb.jpg
```

Neither `manifest.json` ships with the repo — `videos/` and `playlists/` are gitignored, so your library stays yours. The manager writes them on your first import, and until then a fresh install just shows an empty library rather than an error.

Each `manifest.json` is a plain JSON array of folder names, and it controls both **visibility and display order** — a folder that isn't listed in the manifest won't show up at all:

```json
["Drop", "Hopeless", "Question Marks"]
```

The manager's reorder UI just rewrites this array.

### `videos/<folder>/meta.json`

```json
{
  "title": "AMORTAL & Castroe - Drop",
  "videoCreator": "SHIBUI",
  "pathCreator": "Things&Stuff",
  "bpm": 117,
  "description": [
    "The 11th song in BounceX Lite Volume 5.",
    "Credits:",
    "Original Path by [Things&Stuff](https://example.com/)"
  ],
  "tags": ["bouncex", "hard", "single song"],
  "highlightedTags": ["BounceX", "Hard"],
  "videoFile": "drop.mp4",
  "thumbnail": "thumb.jpg",
  "bxFiles": [
    { "label": "Hard - Things&Stuff", "file": "drop.bx" }
  ],
  "durationSecs": 181.867
}
```

Notes on the fields:

- **`bxFiles` is the only truly required one.** It's a list, so one video can carry several paths (difficulties, alternate routes); each entry is `{ "label", "file" }` and the player shows `label` in the path picker. A legacy single `"bxFile": "drop.bx"` is still accepted and normalized to `bxFiles` with the label `Default`.
- **`videoFile`** defaults to `<folder>.mp4` if omitted.
- **`thumbnail`, `description`, `tags`, `highlightedTags`, `bpm`, `videoCreator`, `pathCreator`, `durationSecs`** are all optional. `description` may be a string or an array of lines, and supports `[text](url)` links. `highlightedTags` is the subset of tags shown as badges on the card.
- **`meta.json` itself is optional.** If it's missing, the app synthesizes a minimal one by scanning the folder: it looks for `<folder>.mp4` (then any `.mp4`/`.webm`/`.mkv`/`.mov`), `<folder>.bx` (then any `.bx`), and a thumbnail named `thumb.jpg`, `thumb.png`, `<folder>.jpg`, or `<folder>.png`. The title falls back to the folder name. The manager flags these entries so you can see they're guesses.

The manager page validates every folder and reports missing video files, missing `.bx` files, and missing thumbnails, so it's the fastest way to find a package that's put together wrong.

### `playlists/<folder>/meta.json`

```json
{
  "title": "BounceX LITE Dildo Hero Volume 5",
  "author": "Things&Stuff",
  "description": "All the songs in Volume 5, in order.",
  "tags": ["Easy to Extreme"],
  "thumbnail": "thumb.jpg",
  "totalDurationSecs": 2680.464,
  "videos": [
    "Multiverse",
    "Hope",
    { "id": "The KDA Experience", "bxFile": "thingsandstuff.bx" }
  ]
}
```

`videos` entries reference video folder names. Use the plain-string form for "play this video with its default path", or the object form to pin a specific `.bx` file when the video has several. Playlists hold no media of their own beyond a thumbnail. Unlike videos, playlists **require** a `meta.json`.

## Tools

Two optional helpers for preparing packages. Neither is part of the app, and you never need them just to run it.

| Script | What it does | Needs |
|---|---|---|
| `Tools/splitbx.py` | Splits one `.bx` file into several at the given frame counts — for carving a volume-length path up into per-song files. `python Tools/splitbx.py input.bx 13370 10725 9803 --output-prefix video` | Python 3 |
| `Tools/offset.sh` | Adds black frames to, or trims frames from, the start of a video, so an existing path lines up. Interactive; detects the framerate itself. | bash, ffmpeg |

There is also `bun run sim`, a fake Buttplug server that prints every move it is
sent — for setting up or debugging device output with no hardware attached. See
[docs/device-output.md](docs/device-output.md).

`bun test` runs the device-output test suite (planner, scheduler, wire protocol
and the whole chain end to end). It needs no hardware and no network.

## Updating

Run the updater for your platform:

| Platform | Updater |
|---|---|
| Windows | `Update.ps1` |
| Windows (double-click) | `Update.bat` |
| macOS / Linux | `Update.sh` |

These pull from this fork, [brewswain/BX-Viewer-Fork](https://github.com/brewswain/BX-Viewer-Fork), and refresh dependencies. Your `videos/` and `playlists/` directories are gitignored, so your library is left alone.

## Troubleshooting

If you run into any issues, try a hard refresh:

**Windows/Linux:** `Ctrl + Shift + R`
**Mac:** `Cmd + Shift + R`

This resolves most caching issues that may occur (the app registers a service worker, so a stale cache is the usual culprit). This also may erase some settings. Alternatively, in your browser settings delete your cache/cookies.

If a video doesn't appear at all, check `/manager` — it lists per-folder errors and warnings, and a missing manifest entry is the most common cause.

**`bun install` fails with `EINVAL: Failed to replace old lockfile with new lockfile on disk`** (or a launcher that aborts partway through installing). This happens when the repo lives on an **exFAT** volume — exFAT doesn't support the atomic file-replace semantics Bun uses to write `bun.lock` (it also rejects hardlinks). Nothing is corrupt and there is no stale "old lockfile" to delete, despite what the message says; the packages actually install fine, Bun just exits `1` on the lockfile write. Use `bun install --frozen-lockfile` instead — a `bun.lock` is committed to the repo root, so a frozen install works out of the box and skips the write entirely. Note that *regenerating* `bun.lock` after changing dependencies still needs a checkout on NTFS, ext4, or APFS.

**Need more help?** Check the existing examples in the `videos/` directory for reference implementations, or ask upstream on Discord — the original author is in the [DH Discord Server](https://discord.gg/u6CZ3Zm4PC).

## Credits

- [Alunacoz](https://github.com/Alunacoz/BounceX-Viewer) — original BounceX Viewer, which this repo forks.
- [Optiacku](https://github.com/clbhundley/BounceX) in the [DH Discord Server](https://discord.gg/u6CZ3Zm4PC) — creator of BounceX itself. This project was not endorsed or encouraged by Optiacku; it's merely a more convenient way to view the `.bx` files.

## License

MIT License with the [Commons Clause](https://commonsclause.com/) condition — see [LICENSE](LICENSE). You can use, modify, and redistribute it freely, but you may not sell it or offer it as a paid hosted service.
