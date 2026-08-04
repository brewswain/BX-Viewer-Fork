# Export to OSSM Sauce

Copies a video's `.bx` paths — one, a selection, or a whole playlist — into the
[OSSM Sauce](https://github.com/clbhundley/OSSM-Sauce) desktop app's own
library, and writes a `.bxpl` playlist so they come up in the right order.

Nothing about the `.bx` files changes. The export is a file copy plus a
plain-text index; OSSM Sauce reads them the same as anything you added by hand.

---

## What it writes

OSSM Sauce keeps its library in one fixed place, created at startup
(`ossm_sauce.gd:289`):

```
<Documents>/OSSM Sauce/
├── Paths/            *.bx, *.funscript   ← flat, no subfolders
├── Playlists/        *.bxpl
└── UserSettings.cfg
```

An export drops path files into `Paths/` and one `.bxpl` into `Playlists/`.

**`Paths/` is flat.** The Add Path list is built from `dir.get_files()` on that
one directory (`ossm_sauce.gd:1088`), so a subfolder would simply not be listed.
Because every path shares one namespace, exported files are named after the
video rather than the source file — `hope.bx`, or `hopeless-hard.bx` when a video
has several variants — so `Hard.bx` from two different videos can't collide.

**`.bxpl` is a list of bare filenames**, LF-terminated, one per line, resolved
against `Paths/` by name alone:

```
hopeless-easy.bx
hopeless-hard.bx
```

That is exactly what the app writes itself — `store_line` per entry
(`save_playlist.gd:20`) — and what it reads back line by line
(`add_file.gd:43`). A line the app also understands, but that we never write, is
`delay(2.5)`: a pause instead of a path.

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
(`ossm_sauce.gd:76`) would answer, per platform:

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

---

## Known limits

- **A `.bxpl` carries ordering and nothing else.** It is a list of filenames, so
  the playlist's title, author, tags, thumbnail and per-entry variant labels do
  not survive the export. What arrives in OSSM Sauce is the sequence, under a
  filename you chose.
- **`meta.video_offset_ms` becomes a global setting, not a per-path one.**
  Loading a path copies that value into the single Video Offset field in the app
  (`ossm_sauce.gd:563-566`), so in a playlist each path overwrites the previous
  one's offset and the last load wins for the whole session. Paths whose offsets
  differ have to be loaded one at a time — or exported as separate playlists —
  if the offset matters.
