# Handoff: emitting v2 `.bxpl`

What this exporter would have to do to write OSSM Sauce's **v2** playlist format
instead of the legacy one-name-per-line format it writes today, and what the app
does with each field when it arrives.

Not started. This is the spec and the hazards, written while the app side was
fresh — not a plan anyone has committed to.

The mirror of this document, written for the app's maintainer, is
`BX-VIEWER-EXPORT-HANDOFF.md` at the root of the OSSM Sauce working tree
(`ref-software/OSSM-Sauce/`). Line references below are into
`ossm-sauce-app/scripts/` there.

---

## Read this first

**Emitting v2 will silently turn off the user's shuffle and loop toggles.**

That is not a detail, it is the whole reason this is a handoff and not a patch.
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

This exporter holds no shuffle or loop state to put there. Options, roughly in
order of honesty:

1. **Give the export overlay its own shuffle/loop controls** and send what the
   user picked. Now v2 is expressing something, which is the point.
2. **Ask the app to distinguish "absent" from `false`** — the same null-vs-zero
   treatment `video_offset_ms` already got. Cheap on that side (`data.has(...)`
   rather than `data.get(..., false)`), and it makes a flag-less v2 file
   possible. Needs a change over there, so it is a conversation, not a decision
   to take unilaterally.
3. Emit v2 and accept clobbering the toggles. Only defensible if the overlay
   says so out loud.

Everything below assumes one of those is settled first.

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

`bxplBody` (`lib/ossm/naming.ts:93`) is the single choke point — every route
goes through it:

```ts
export function bxplBody(lines: string[]): string {
  return lines.map((l) => `${l}\n`).join('')
}
```

Three callers, all of which pass a `string[]` that came from `playlistFor`
(`lib/ossm/bundle.ts:330`):

| Call site | Route |
|---|---|
| `lib/ossm/storage.ts:485` | server-side install, writes into `Playlists/` |
| `lib/ossm/bundle.ts:308` | zip download, `Playlists/<name>.bxpl` |
| `lib/ossm/app.ts:242` | browser → app HTTP, `{ text }` to `/load_playlist` |

The shape of the change is to widen the currency from `string[]` to an entry
array, and let `bxplBody` serialise it. Keeping one function that owns the bytes
is what makes the three routes provably identical, so resist the temptation to
build JSON at any individual call site.

### The hazard in `app.ts`

`sendOssmPayload` rewrites the playlist *after* the files are uploaded
(`lib/ossm/app.ts:202-216`). The app decides its own names on `/load_path` —
name clashes become `foo (2).bx` — and answers with the name it chose, so each
requested name is substituted for the stored one, and a line whose file never
stored is dropped rather than left to be counted `missing`:

```ts
const stored = new Map<string, string | null>()
for (const f of files) stored.set(f.requested, f.stored)
```

That map is keyed by the line string itself. Under v2 the substitution has to
move to `entry.path` and leave every sibling key on the entry untouched — an
entry that gets renamed must keep its `count`, `seconds` and `video_offset_ms`.
`OssmSendResult.playlistLines` and `droppedLines` (`lib/ossm/types.ts:172-174`)
are `string[]` and surface in the overlay; decide whether they stay names or
become entries before touching them.

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

`lib/ossm/bundle.test.ts`, `app.test.ts` and `storage.test.ts` all assert on the
`.bxpl` body. Worth adding on top of whatever they become:

- A minimal queue round-trips to entries carrying only `path` — no default
  `mode`/`count` noise.
- A renamed file (`foo (2).bx`) keeps its repeat and offset keys.
- An entry with no offset omits the key entirely; one with `0` writes `0`.
- Shuffle/loop carry whatever the overlay decided, per the warning at the top.

The app side has no fixture-based test suite to mirror this against — v2 parsing
was verified there by a throwaway autoload, since deleted.
