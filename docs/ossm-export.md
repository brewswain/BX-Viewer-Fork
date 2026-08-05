# Export to OSSM Sauce

Copies a video's `.bx` paths — one, a selection, or a whole playlist — into the
[OSSM Sauce](https://github.com/clbhundley/OSSM-Sauce) desktop app's own
library, and writes a `.bxpl` playlist so they come up in the right order.

Nothing about the `.bx` files changes. The export is a file copy plus a
plain-text index; OSSM Sauce reads them the same as anything you added by hand.

Line references below are into the OSSM Sauce working tree at
`ref-software/OSSM-Sauce/ossm-sauce-app/scripts/`. Its mirror image — what this
exporter assumes about that app, written for *that* app's maintainer — is
`BX-VIEWER-EXPORT-HANDOFF.md` at the root of the same repo.

---

## What it writes

OSSM Sauce creates its library at startup (`ossm_sauce.gd:446`):

```
<Documents>/OSSM Sauce/
├── Paths/            *.bx, *.funscript   ← flat, no subfolders
├── Playlists/        *.bxpl
└── UserSettings.cfg
```

An export drops path files into `Paths/` and one `.bxpl` into `Playlists/`.
That layout is fixed except for one setting, which moves `Paths/` out from under
Documents — see [When `Paths/` isn't under
Documents](#when-paths-isnt-under-documents).

**`Paths/` is flat.** The Add Path list is built from `dir.get_files()` on that
one directory (`ossm_sauce.gd:2185`, in `list_files`), so a subfolder would
simply not be listed. Because every path shares one namespace, exported files
are named after the video rather than the source file — `hope.bx`, or
`hopeless-hard.bx` when a video has several variants — so `Hard.bx` from two
different videos can't collide.

**`.bxpl` is a list of bare filenames**, LF-terminated, one per line, resolved
against `Paths/` by name alone:

```
hopeless-easy.bx
hopeless-hard.bx
```

That is the app's **legacy v1** format, and no longer what it writes itself:
saving a playlist in OSSM Sauce now emits **v2 JSON** (`save_playlist.gd:30` →
`PlaylistFormat.serialize`). The export is not broken by that — it is writing a
format the app still reads but no longer produces. `PlaylistFormat.deserialize`
sniffs the first non-whitespace character, takes `{` as v2, and otherwise falls
through to the legacy line parser (`playlist_format.gd:68-74` → `_parse_legacy`,
`playlist_format.gd:164-191`). A line that parser also understands, but that we
never write, is `delay(2.5)` (`playlist_format.gd:172-176`): a pause instead of
a path.

**Nothing is ever overwritten.** Before copying, each file is compared against
what is already in `Paths/`:

| Result | Meaning |
|---|---|
| `new` | No file of that name. Copied. |
| `identical` | Same name, same bytes (size, then sha256). Skipped, and the playlist points at the existing file. |
| `renamed` | Same name, *different* bytes. Copied as `name-<hash8>.bx` instead, leaving the original alone. |

The suffix comes from the new file's own hash, so re-running an export picks the
same name again rather than piling up copies. An existing `.bxpl` of the same
name is not replaced either — the export becomes `My List (2).bxpl` and says so.

There is also a **download** option, which packages the same `Paths/` +
`Playlists/` layout as a zip. Use that when the browser isn't on the machine
running OSSM Sauce; installing writes to the *server's* Documents folder.

---

## Finding "Documents"

This is the only genuinely fiddly part. `~/Documents` is the wrong answer on
Windows more often than not: with OneDrive Known Folder Move switched on — the
default on new installs — Documents is redirected into the OneDrive folder,
`C:\Users\you\Documents` may still exist as an empty leftover, and writing there
produces an export the app never sees. No error, nothing missing, just a folder
OSSM Sauce doesn't read.

So the resolver asks what Godot's `OS.get_system_dir(SYSTEM_DIR_DOCUMENTS)`
(`ossm_sauce.gd:168`, with `cfg_path` / `paths_dir` / `playlists_dir` derived
from it at `168-171`) would answer, per platform:

| Platform | Godot calls | We use, in order |
|---|---|---|
| Windows | `SHGetKnownFolderPath(FOLDERID_Documents)` — honours OneDrive redirection | `%OneDrive%\Documents`, `%OneDriveCommercial%\Documents`, `%USERPROFILE%\Documents`, then the known folder itself, read from `HKCU\…\Explorer\User Shell Folders` → `Personal` |
| macOS | `NSSearchPathForDirectoriesInDomains(NSDocumentDirectory)` | `~/Documents` |
| Linux | `xdg-user-dir DOCUMENTS` | `$XDG_DOCUMENTS_DIR`, then `XDG_DOCUMENTS_DIR` from `~/.config/user-dirs.dirs`, then `~/Documents` |

Whichever candidate **already holds an install** wins, regardless of order — a
folder containing `UserSettings.cfg` or `Paths/` is the app's, and no amount of
guessing beats that. Only when nothing is installed anywhere does order matter,
and then the answer is a best guess at where the app *will* create it. On
Windows that guess is the registry value, because it is what `SHGetKnownFolderPath`
returns.

On macOS, plain `~/Documents` stays correct with iCloud "Desktop & Documents"
sync on: that feature makes `~/Documents` *be* the synced location rather than
moving it, so there is no `~/Library/Mobile Documents` special case.

### Overriding it

If the folder is somewhere else entirely — a portable install, a second user
account, a Documents folder redirected somewhere the registry doesn't admit to:

```sh
OSSM_SAUCE_DIR="D:/Apps/OSSM Sauce"
```

or in `config.json` next to the launcher:

```json
{ "ossmSauceDir": "D:/Apps/OSSM Sauce" }
```

Either may point at the `OSSM Sauce` folder itself or at the Documents folder
that contains it; both forms work, and neither produces a nested
`OSSM Sauce/OSSM Sauce`. The env var wins over `config.json`, and both win over
detection.

### When `Paths/` isn't under Documents

OSSM Sauce lets the user point its **paths folder** somewhere else
(`custom_paths_dir`, persisted as `[storage] paths_dir` in `UserSettings.cfg`).
`_resolve_storage_dir` (`ossm_sauce.gd:2326-2333`) honours it for the `paths`
category *only* — the `category == "paths"` guard is the whole redirect.
Playlists stay under Documents either way.

**The resolver here has no concept of that setting.** If the user has set one,
an install writes the `.bxpl` where the app reads it and the `.bx` files where
it does not — and reports success, because from this side both writes worked.
Symptom: the playlist appears in Load Playlist, and every entry in it is
missing. Neither `OSSM_SAUCE_DIR` nor `ossmSauceDir` fixes it; they move the
whole tree, not just `Paths/`.

Two ways round it, for now: unset the custom folder in the app, or use
**Download** and extract into the right two places by hand. The app also
accepts path and playlist *content* over its MCP HTTP server (`/load_path`,
`/load_playlist`; same port as device output, default 8081) and resolves its own
storage folder when it writes — so that route is immune by construction. This
exporter does not use it yet; see `BX-VIEWER-EXPORT-HANDOFF.md` in the OSSM
Sauce repo for the request and response shapes.

---

## Known limits

- **A `.bxpl` carries ordering and nothing else.** It is a list of filenames, so
  the playlist's title, author, tags, thumbnail and per-entry variant labels do
  not survive the export. What arrives in OSSM Sauce is the sequence, under a
  filename you chose. Emitting v2 instead would buy per-entry repeat and
  playlist-level shuffle/loop (`playlist_format.gd:26-55` is the whole writer),
  but no metadata fields — the format has nowhere to put them either.
- **`meta.video_offset_ms` becomes a global setting, not a per-path one.**
  Loading a path copies that value into the single Video Offset field in the app
  (`ossm_sauce.gd:799-802`), so in a playlist each path overwrites the previous
  one's offset and the last load wins for the whole session. Paths whose offsets
  differ have to be loaded one at a time — or exported as separate playlists —
  if the offset matters.
