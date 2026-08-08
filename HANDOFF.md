# Handoff

Where the OSSM Sauce export work stopped, written 2026-08-07 for whenever this
repo gets opened again. Delete this file once the items below are dealt with.

Everything shipped is in **`6931a06`** — *"Let an export state shuffle and loop,
or decline to"* — pushed to `origin/main`. Working tree was clean afterwards.

## What changed, in one paragraph

The exporter can now write OSSM Sauce's **v2** `.bxpl` format instead of only the
legacy one-name-per-line format. It does so **only when it has something to
say**: the export overlay's new shuffle/loop control starts unset, unset writes
v1, and setting either flag writes v2 carrying both. That asymmetry is forced —
`has_flags` is `false` for legacy files but hard-`true` for every v2 file, so v2
has no way to decline to state the flags, and an exporter that always wrote v2
would silently switch off the shuffle and loop toggles of anyone who had them on.

Full detail lives in the docs, which are current as of that commit — read these
rather than re-deriving:

- **`docs/ossm-export.md`** → *Which format a `.bxpl` comes out in*
- **`docs/ossm-bxpl-v2-handoff.md`** → format spec, per-entry keys, and the
  record of what was and wasn't done, and why

## Before touching anything

- Verify with **`bun test`** and **`bun run typecheck`**. That is the whole set —
  **this repo has no lint step** (no `lint` script, no eslint dependency). Don't
  go hunting for one; `next lint --dir` in particular is not valid here.
- Last known good: 197 tests pass, typecheck clean.

## What's left

### 1. Nobody has ever loaded a v2 file into the real app

This is the only genuine gap. Every assertion in `lib/ossm/naming.test.ts`
encodes a *belief* about the app's `playlist_format.gd`, read from source. Unit
tests cannot catch a wrong belief, and v2 goes through a parser that v1 never
touched.

Two-minute manual check:

1. Export a playlist with the shuffle toggle **ticked** → drop the `.bxpl` into
   the app's `Playlists/` → load it → the app's shuffle toggle should turn on.
2. Export again with the flags control **off** → load → the toggle must be left
   **exactly as it was**.

Step 2 is the one that matters. It is the regression the entire design exists to
prevent, and it is the half that fails silently.

### 2. Per-entry keys — deferred on purpose, still blocked

v2 can carry `mode` / `count` / `seconds` / `video_offset_ms` / `delay` per
entry. None are written. Entries are already objects so adding them won't touch
the three export routes again, but two things block it:

- Nothing writes `VideoMeta.offset` on any video today, so there are no values.
- That field's doc comment and its two call sites (`app/watch/page.tsx`,
  `app/playlist/page.tsx`) disagree by a factor of 1000. Resolve that first — a
  wrong answer here is silent.

### 3. An unposted issue for the upstream app — your call

`docs/ossm-sauce-issue-draft.md` asks `clbhundley/OSSM-Sauce` to read
`shuffle`/`loop` with `data.has(...)`, so a v2 file *can* decline to state them —
the same absent-vs-`0` treatment `video_offset_ms` already gets there.

It has **not been filed.** It's a third party's repo, so that was left as a
decision rather than taken. Nothing in this repo depends on it landing; if it
ever did, the flags control could grow a third "leave alone" state and the
one-flag-writes-the-other wart would go away. Both docs currently say, truthfully,
that it hasn't been raised — if it gets filed, flip those two mentions and cite
the issue number.

## Known behaviour, not a bug

A multi-playlist export in the manager overlay writes the **same** flags into
every `.bxpl` it produces — there's one control per export action. That was the
intended reading of "one export, one intent". Per-playlist flags would be a
different UI, worth doing only if it actually annoys someone.
