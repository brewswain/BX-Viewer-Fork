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

The app has since grown a JSON playlist format carrying repeat modes and a
per-entry video offset, which this exporter does not write. What that would take,
and why it is not a free upgrade: [`ossm-bxpl-v2-handoff.md`](./ossm-bxpl-v2-handoff.md).

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

That is the **install** route, and everything above describes it. There are two
others — see [The three routes out](#the-three-routes-out).

---

## The three routes out

| Route | Who writes | Works from | API |
|---|---|---|---|
| **Download** a zip laid out as `Paths/` + `Playlists/` | the user, by extracting | anywhere | `POST /api/manager/ossm/bundle` |
| **Install** into the storage folder | this viewer's Node server | only the machine running the server — `isLoopbackRequest` refuses the rest with 403 (`lib/ossm/bundle.ts`) | `POST /api/manager/ossm/plan`, then `/install` |
| **Send to the app** over its HTTP server | OSSM Sauce itself | anywhere that can reach the app's port | `POST /api/manager/ossm/payload`, then the browser posts to the app |

Install is the odd one out: the viewer is normally served on a LAN port, so a
phone tapping Install would fill the *server's* Documents folder rather than its
own. Hence the 403, and hence the third route.

### Send to the app

OSSM Sauce's MCP HTTP server (same port as device output, default **8081**,
bound to `0.0.0.0`) takes path and playlist *content* and does the write itself:

```
POST /load_path      {"name": "hopeless-hard.bx", "data_b64": "…", "queue": false}
  -> {"status":"stored","name":"hopeless-hard (2).bx","reused":false,…}
POST /load_playlist  {"text": "hopeless-hard (2).bx\n…", "replace": true}
  -> {"status":"loaded","entries":3,"missing":0,"source":""}
```

Two consequences fall straight out of the app doing the write:

- **It is immune to `custom_paths_dir`.** The app resolves its own storage
  folder, so the setting that silently breaks Install (below) cannot apply.
- **It works from a phone.** The requests go out from the *browser*, never
  through this viewer's Node server — routing them through Node would put us
  back on "whose machine is this?". The app is built for it: `OPTIONS` is
  answered 200 and every response carries `Access-Control-Allow-Origin: *`.

The server's part is `/api/manager/ossm/payload`, which returns the same planned
export as the zip with each file base64-encoded. It plans like the download and
not like an install, deliberately: what is already in the app's `Paths/` is the
app's business, and it answers with the name it chose.

**Read `name` back off every `/load_path` response.** The app never overwrites
either: identical bytes reuse the file it has (`reused: true`), and a name held
by *different* bytes is stored as `hopeless-hard (2).bx` — a different
convention from this side's content-hash suffix, so don't expect the two to
agree. The `.bxpl` posted afterwards is built from the names that came back
(`applyStoredNames`, `lib/ossm/app.ts`).

`replace` is left off the first `/load_playlist`. A playlist replaces the queue,
and the app refuses with **409** when the queue is not empty and the caller
didn't say it meant to — the one chance the user gets to object, since an HTTP
caller cannot be prompted down the connection it is waiting on. The UI asks and
retries; it never silently discards a queue that may be playing. Other answers:
**400** malformed (and the queue is never touched), **422** stored but wouldn't
load, **404** no such stored playlist, **503** no paths folder yet, **413** over
16 MB — per request, so per file.

The app's address is stored **per device** in localStorage (`ossmAppUrl`),
defaulting to this page's own hostname on port 8081: from
`http://192.168.1.5:3000` the app is very likely `http://192.168.1.5:8081`. It
has to be per device — the phone's answer and the desktop's answer are different
addresses, and a server-side setting could only hold one of them.

Partial success is a real outcome here: files can store and the playlist still
fail. What landed is reported rather than the whole send being called failed.

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

Use **[Send to the app](#send-to-the-app)** instead: the app resolves its own
storage folder when it writes, so that route is immune by construction. Failing
that, unset the custom folder in the app, or use **Download** and extract into
the right two places by hand.

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
