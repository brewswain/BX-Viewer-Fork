# Handoff: emitting v2 `.bxpl`

What this exporter would have to do to write OSSM Sauce's **v2** playlist format
instead of the legacy one-name-per-line format, and what the app does with each
field when it arrives.

**Partly done.** The root — `version`, `shuffle`, `loop`, `entries` — is written,
gated on the user having stated the flags; see [Read this
first](#read-this-first) and [Which format a `.bxpl` comes out
in](./ossm-export.md#which-format-a-bxpl-comes-out-in). The per-entry keys
(`mode`, `count`, `seconds`, `video_offset_ms`, `delay`) are **not**, and the
rest of this document is still the spec for those.

The mirror of this document, written for the app's maintainer, is
`BX-VIEWER-EXPORT-HANDOFF.md` at the root of the OSSM Sauce working tree
(`ref-software/OSSM-Sauce/`). Line references below are into
`ossm-sauce-app/scripts/` there.

---

## Read this first

**Emitting v2 unconditionally will silently turn off the user's shuffle and loop
toggles.** *(Resolved — kept because it is why the exporter still writes v1 at
all, and the constraint any future change has to hold.)*

Legacy files carry no flags, so the app leaves the toggles alone
(`ossm_sauce.gd:1019-1022`):

```gdscript
# Legacy files carry no flags; leave the user's current toggles alone.
if parsed["has_flags"]:
    shuffle_enabled = parsed["shuffle"]
    loop_playlist = parsed["loop"]
```

`has_flags` is `false` for legacy and hard-`true` for **every** v2 file
(`playlist_format.gd:135`). There is no "v2 file that declines to say" — the
keys default to `false` when absent, and `has_flags` is true regardless. So the
moment this exporter emits v2, every export asserts `shuffle: false, loop:
false` at an app whose user may well have both on, and turns them off.

**What was done: 1, plus the observation that the format choice is itself the
answer.** The export overlay grew a shuffle/loop control that starts unset, and
`bxplBody` picks the format from it — unset writes v1, which is the only way to
decline to state the flags, and either one set writes v2 carrying both. So an
export only overwrites those toggles when the user asked for it. Nothing was
needed from upstream, and both formats load forever, so this is not a bet.

The two options not taken:

- **Ask the app to distinguish "absent" from `false`** — the same null-vs-zero
  treatment `video_offset_ms` already got, `data.has(...)` rather than
  `data.get(..., false)`. Not implemented here and **not yet raised with them**;
  it is their change to make. The argument is written up in
  [`ossm-sauce-issue-draft.md`](./ossm-sauce-issue-draft.md), unfiled. It would
  compose with what shipped rather than
  replace it: once a v2 file can decline to state the flags, the control grows a
  third "leave alone" state and the v1 fallback becomes a compatibility path
  instead of the mechanism. Nothing here depends on it happening.
- **Emit v2 and accept clobbering the toggles.** Rejected — writing v1 costs
  nothing and clobbers nothing.

The residue is that setting one flag writes the other at `false`, because v2
cannot say less. That is why the control sets them as a pair, and it is what the
upstream fix would remove.

---

## The format

`playlist_format.gd` is the entire reader and writer — 269 lines, no scene
access, worth reading end to end before implementing against this summary.
The app writes v2 via `save_playlist.gd:30` → `PlaylistFormat.serialize`.

Reading sniffs the first non-whitespace character: `{` means v2, anything else
falls through to the legacy line parser (`deserialize`, `playlist_format.gd:83`).
So legacy exports keep working forever; this is additive.

```json
{
	"version": 2,
	"shuffle": false,
	"loop": false,
	"entries": [
		{ "path": "hope.bx" },
		{ "path": "hopeless-hard.bx", "mode": "count", "count": 3 },
		{ "path": "drop.bx", "mode": "time", "seconds": 90.0, "video_offset_ms": 2500 },
		{ "delay": 2.5 }
	]
}
```

Tab-indented, `JSON.stringify(root, "\t", false)`. Nothing reads the whitespace;
match it only to keep diffs against app-written files quiet.

### Root

| Key | Type | Notes |
|---|---|---|
| `version` | int | Absent defaults to 2. `version > 2` **refuses the whole file** with "Playlist was written by a newer version". Do not bump it speculatively. |
| `shuffle` | bool | Applied on load. See the warning above. |
| `loop` | bool | Same. |
| `entries` | array | Required, must be an array. Absent or wrong type is a hard error. |

### Entry

Each entry is an object carrying **either** `path` **or** `delay`, never
neither. Parse rules from `_parse_v2_entry` (`playlist_format.gd:141`):

| Key | Type | Rule |
|---|---|---|
| `path` | string | Trimmed. Empty after trimming → "Entry N has an empty path." Resolved against `Paths/` by name alone, exactly as a legacy line is. |
| `delay` | number | Must be `> 0`, else "Entry N has a non-positive delay." Mutually exclusive with `path` in practice — `delay` is checked first and wins. |
| `mode` | `"count"` \| `"time"` | Lowercased before matching. Anything else is a hard error naming the mode. Absent means `"count"`. |
| `count` | int | Clamped to `>= 1`. Non-numeric is a hard error. |
| `seconds` | number | Must be `> 0` **when `mode` is `"time"`**, else a hard error. Non-numeric is a hard error. |
| `video_offset_ms` | int | Optional. See below. Non-numeric is a hard error. |

Every error aborts the entire load — there is no skip-the-bad-entry path. A
single malformed entry costs the user the whole playlist, so validate before
sending rather than letting the app be the validator.

**Omit at the default.** The app's own writer emits `mode`/`count` only when
`count != 1`, and `mode`/`seconds` only in time mode (`serialize`,
`playlist_format.gd:45-52`). A plain queue round-trips to a minimal file. Match
that: writing `"mode": "count", "count": 1` on every entry is noise that makes
real repeat settings hard to spot in a diff.

### `video_offset_ms`

Optional integer, milliseconds, on a `path` entry. How far the video runs before
that entry's path starts moving.

Added to the app on 2026-08-07 (`ossm_sauce.gd`, `entry_video_offset` /
`set_entry_video_offset` / `_apply_entry_video_offset`). Before that the Video
Offset field was one global value, so the last path loaded owned the offset for
the entire queue.

**Omit it rather than writing `0`.** Absence means "this entry has nothing to
say about its offset", and the app honours that by leaving the field exactly as
it was. `0` is a positive assertion that the path starts at the top of the
video, and will overwrite whatever the user had dialled in. The app models this
as `null`, not a sentinel, precisely so the two cannot be confused.

An offset in the playlist **overrides** the one in the `.bx`'s own
`meta.video_offset_ms`, on the grounds that it is the later statement about that
entry (`apply_playlist`, `ossm_sauce.gd:1013-1017`).

`VERSION` deliberately stayed at **2** when this key was added, because
`_parse_v2_entry` ignores keys it does not recognise. A build predating the key
loads the file and drops the offsets; a version bump would have made it refuse
the playlist outright. The same reasoning applies to anything added later.

---

## Where the source is

`bxplBody` (`lib/ossm/naming.ts:131`) is the single choke point — every route
goes through it, and it is where both the format choice and the serialisation
live:

```ts
export function bxplBody(playlist: OssmFlags & { entries: OssmEntry[] }): string {
  if (!statesFlags(playlist)) return playlist.entries.map((e) => `${e.path}\n`).join('')
  // …otherwise the v2 root, with both flags coerced to bool
}
```

Three callers, all of which pass the `OssmPlaylist` built by `playlistFor`
(`lib/ossm/bundle.ts:342`):

| Call site | Route |
|---|---|
| `lib/ossm/storage.ts:486` | server-side install, writes into `Playlists/` |
| `lib/ossm/bundle.ts:315` | zip download, `Playlists/<name>.bxpl` |
| `lib/ossm/app.ts:248` | browser → app HTTP, `{ text }` to `/load_playlist` |

The currency between them is an **entry array**, not a `string[]` — entries are
objects today only so the per-entry keys below can be added without touching
these three sites again. Keeping one function that owns the bytes is what makes
the routes provably identical, so resist the temptation to build JSON at any
individual call site.

### The hazard in `app.ts` *(handled)*

`sendOssmPayload` rewrites the playlist *after* the files are uploaded. The app
decides its own names on `/load_path` — name clashes become `foo (2).bx` — and
answers with the name it chose, so each requested name is substituted for the
stored one, and an entry whose file never stored is dropped rather than left to
be counted `missing`.

That map used to be keyed by the line string itself and to rebuild the line from
scratch. `applyStoredNames` (`lib/ossm/app.ts:204`) now keys on `entry.path` and
spreads the rest of the entry through, so a renamed entry keeps its `count`,
`seconds` and `video_offset_ms` once anything writes them. There is a test for
that specifically, ahead of any writer existing.

`OssmSendResult` carries `sentPlaylist: OssmPlaylist | null` and
`droppedPaths: string[]` (was `playlistLines` / `droppedLines`). The 409
replace-queue retry re-sends `sentPlaylist` rather than rebuilding it, which is
what keeps the flags on the retried request.

---

## The offset, once v2 exists

`VideoMeta.offset` (`lib/player/types.ts:74`) is a per-video path start offset
and is the natural source. **Nothing sets it on any video today** —
`CreateVideoOverlay.tsx:494` is the only writer and the field is optional — so
this buys nothing until some do. That is why it sits behind the v2 work rather
than beside it.

**Route it through the `.bxpl`, not through `meta.video_offset_ms` in the
`.bx`.** The app reads both, and the `.bx` route looks tempting because it works
for a bare drop with no playlist at all. It is much more expensive here:
`buildPayload` (`lib/ossm/bundle.ts:220`) reads each path with `fs.readFile` and
base64s it straight into `/load_path`. **The bytes that arrive are the library's
bytes, untouched** — that property is stated in `docs/ossm-export.md` and worth
keeping. Writing a `meta` block means rewriting them on the way out *and*
up-converting v1 files, which are a flat marker map with no `meta` wrapper to
write into. The playlist key costs one field on an object that is already being
built.

### Units

`VideoMeta.offset` is documented as *"Watch treats it as ms, playlist as seconds
(legacy quirk)"*. Both call sites divide by 1000:

- `app/watch/page.tsx:416` — `meta.offset / 1000`
- `app/playlist/page.tsx:328-331` — `meta.offset / 1000`, with a comment
  asserting it is milliseconds

The comment and the code disagree; the comment looks stale. Confirm against a
video that actually sets it before porting the quirk forward — `video_offset_ms`
is unambiguously milliseconds, and a factor-of-1000 error here is silent.

---

## Tests

`lib/ossm/naming.test.ts` covers `bxplBody` itself: the v1/v2 choice, the empty
playlist, tab indent and key order against the app's writer, `version` staying at
2, and the one-flag-writes-the-other wart — that last one is the test that
changes if the upstream fix lands. `bundle.test.ts`, `app.test.ts` and
`storage.test.ts` assert on the entries and the flags riding through.

Already covered from the original list: a minimal queue round-trips to entries
carrying only `path`, and a renamed file keeps its repeat and offset keys.

Still to add, with the per-entry keys:

- An entry with no offset omits the key entirely; one with `0` writes `0`.
- A `delay` entry, if this ever writes one.

The app side has no fixture-based test suite to mirror this against — v2 parsing
was verified there by a throwaway autoload, since deleted.
