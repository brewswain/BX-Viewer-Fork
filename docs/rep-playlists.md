# Rep playlists — repeating the same video at chosen positions

**Status: planned, not built.** Written 2026-08-09. This is a design plan, not a
record of shipped behaviour — nothing below exists in the code yet.

## What this is for

Authoring a *set*: the same video listed several times in one playlist, in an
order you chose, so each appearance is a rep. The intended use is sizing up —
rep 1 runs a gentle `.bx` path, rep 2 a harder one, and so on — but the plain
case (list the same video three times in a row) is the same feature.

## Why the existing loop controls do not cover it

They deliberately don't. `lib/player/playback.ts` opens by saying so:

> Repeat is deliberately a per-track *setting* rather than a duplicated entry:
> playlists reject duplicate videos … so wanting a favourite twice has to be
> expressed here instead.

Per-track repeat (`off` / `once` / `forever`) and playlist loop (`off` / `all` /
`one`) can only replay a track **back-to-back, at its one position, with its one
`.bx` file**. Neither can put video A at positions 1, 4 and 7 with three
different paths, which is the whole point of a rep playlist. So this is a new
capability, not a re-skin of the loop buttons — and the loop buttons stay
exactly as they are.

## The rule that has to be relaxed, and what it was holding up

"No duplicates" is not just a manager-UI nicety; two things lean on it.

1. **`CreatePlaylistOverlay`** disables a pool item once it is in `selected`
   (`isAdded`, `components/manager/CreatePlaylistOverlay.tsx:664`), so a second
   copy cannot be added.
2. **Playback prefs are keyed by video folder id** — `PlaylistPrefs.tracks` is a
   `Record<folderId, LoopMode>`, `currentFolder` identifies the playing track,
   and `barLoopMode` / `rowLoopMode` / `cycleRowLoop` all match on it. The doc
   comment says why folder id rather than index: *"so reordering cannot shift
   it"*. With duplicates present, folder id stops identifying a row — setting
   `+1` on rep 2 would silently set it on reps 1 and 3 as well.

Point 2 is the actual work. Everything else is UI.

## Design

### A per-entry key, not an index

Give each playlist entry a **stable per-entry id** (`uid`) written into
`meta.json` at authoring time, and key playback prefs by that instead of by
folder id:

```jsonc
{
  "title": "Warmup Ladder",
  "kind": "reps",
  "videos": [
    { "id": "Hips", "uid": "e1", "bxFile": "Hips-easy.bx" },
    { "id": "Hips", "uid": "e2", "bxFile": "Hips-medium.bx" },
    { "id": "Hips", "uid": "e3", "bxFile": "Hips-hard.bx" }
  ]
}
```

`uid` survives reordering (an index would not) and distinguishes copies (a
folder id would not). Entries are **already** either a bare string or
`{ id, bxFile }` — `app/playlist/page.tsx:202` and
`CreatePlaylistOverlay.tsx:308` both handle the object form — so this adds a
field to a shape that exists rather than a new shape.

**Back-compat falls out for free:** define

```ts
entryKey(entry) = entry.uid ?? entry.id
```

For every playlist authored so far there are no duplicates and no `uid`, so
`entryKey` *is* the folder id, and existing `bx_playlist_playback:<id>`
localStorage prefs keep matching without a migration. Only rep playlists ever
see a `uid`.

### A playlist `kind`, so ordinary playlists keep the guard

**Decided: keep it.** Mark the playlist itself (`"kind": "reps"`, absent meaning
normal). The duplicate ban is a genuine correctness guard for ordinary
playlists — a double-click on a pool item should not silently double a track.
Lifting it globally trades a real protection for a feature almost no playlist
wants, so lift it only where it was asked for.

The alternative considered was storing nothing and inferring rep-ness from the
entries (`new Set(ids).size !== ids.length`). It was rejected because of the
chicken-and-egg in the manager: before the second copy is added there are no
duplicates to infer from, so nothing can tell the overlay to permit that add.
A stored declaration says it up front.

The player does not branch on `kind`. It keys by `entryKey` unconditionally,
which is correct for both kinds; `kind` exists for the **manager** (which
affordance to show) and for the browse card (so a rep playlist reads as one).

`kind` is the single source of truth — read it, don't re-derive rep-ness from
the entries anywhere, or the two answers will disagree on a playlist edited down
to no duplicates. Corollary: the overlay must clear `kind` when the user turns
the mode off, since nothing else will.

### The browse pill

A rep playlist gets a pill on its card in `components/browse/PlaylistCard.tsx`;
ordinary playlists get **nothing added**, so the pill is the marked case and
stands out rather than becoming visual noise on every card. Rendered from
`kind === 'reps'`.

Two existing styles to borrow from rather than inventing a third: `card-tag`
(the highlight-tag pills in the card body) and `card-duration` (the overlay chip
on the thumbnail, which already carries the "N videos" count). The thumbnail
corner is the more visible of the two.

While in that file: `videoCount` is `p.videos.length`, which on a rep playlist
counts **entries, not videos** — a 3-video ladder would read "12 videos" in the
thumb chip, the `card-meta` row, and the sidebar's `N / M` counter. Decide the
wording once and use it in all three (e.g. "3 videos · 12 reps").

### Per-entry `.bx` is already the sizing-up mechanism

Nothing new is needed for "harder each rep": the per-entry `bxFile` override
already exists and already flows through
`app/playlist/page.tsx:202` → `trackMeta(folder, bxOverride)`. A rep playlist is
"same `id`, different `bxFile`, N times". That is the cheapest part of this.

## Work, in dependency order

1. **`lib/player/playback.ts` / `playbackStore.ts`** — rename the folder-keyed
   concept to an entry key: `PlaylistPrefs.tracks` keyed by `entryKey`,
   `currentFolder` → `currentKey` (the folder id is still needed separately for
   loading media, so this is a split, not a rename), and the four functions that
   match on it. `advance()` and `shuffledOrder()` are untouched — they already
   work in indices. `playback.test.ts` covers these; extend it with a
   duplicate-bearing fixture and assert `+1` on rep 2 leaves reps 1 and 3 alone.
   Also drop or rewrite the file's opening comment and the
   `TrackRepeatButton` doc comment (`app/playlist/page.tsx:690`) — both assert
   the rule this change relaxes.
2. **Reading and building entries** — `entryKey`, `uid` minting on save, and
   duration summing **with multiplicity** (`totalDurationSecs` in `meta.json`;
   see `lib/manager/duration.ts`).
3. **`CreatePlaylistOverlay`** — a `kind` toggle; when `reps`, the pool item
   stays enabled and adds another copy, and the selected list needs a duplicate
   button ("add another rep") plus per-copy `.bx` pickers. The selected list is
   already index-addressed (`prev.map((v, i) => …)`), so removal and reorder
   already work on copies. Also a **×N field on a selected row** — see below.
   Turning the toggle back off with duplicates present has to be handled: refuse
   with a message, or collapse to the first copy of each. Refusing is safer.
4. **Sidebar rows** — already `key={i}` (`app/playlist/page.tsx:637`), so no key
   fix is needed. Rows will show the same title three times; add the rep
   position (`Hips · rep 2/3`) or the `.bx` label, or the list is unreadable.
5. **OSSM export** — check `components/manager/OssmExportOverlay.tsx:217`. That
   `seen.includes(pin)` dedupe is right for *which path files to copy* (copy
   each once) but must not collapse the *playlist listing*, which has to keep
   every rep. Distinct per-rep `.bx` files make this mostly moot; identical ones
   are the case to test. `.bxpl` itself is fine with duplicates in both v1
   (one name per line) and v2 (entry objects) — see `docs/ossm-export.md`.

## The ×N field — an authoring shortcut, never a stored shape

**Decided.** A selected row carries a count you can type (`3`), and it
**expands immediately in the overlay** into three separate rows, each with its
own `uid` and its own `.bx` picker. The count is never written anywhere; what is
saved is the flat list of entries the expansion produced.

The rejected alternative was storing `{ "id": "Hips", "count": 3 }` and
expanding at load time. It reads as tidier and isn't, because sizing up needs a
**different `.bx` per rep**: the moment rep 2 gets the harder path the entry has
to split into three anyway, so the code would carry both shapes plus the
conversion between them. A stored `count` only ever describes N *identical*
back-to-back plays, which is roughly what per-track `forever` / `+1` already
does.

So the count is a seed — type 3, get three rows, then edit each independently.
Storage, `entryKey`, and the duration sum all stay simple because there is only
one shape on disk.

## Shuffle stays available

**Decided: no branching on `kind`, shuffle works on rep playlists like any
other.** It won't be the normal way to play a ladder, but a deliberately
shuffled bag of duplicates is its own thing — draw at random from a weighted
pool, where listing a video three times makes it three times as likely.

This is also the zero-work option, and correctly so rather than by luck: the
order machinery in `lib/player/playback.ts` is entirely index-based —
`shuffledOrder(n, pin)` permutes `0..n-1`, `advance()` walks positions within
`order`, and `toggleShuffle` pins by `currentIndex`. None of it ever compares
video identity, so duplicate entries are already just distinct indices to it.
`reshuffle()` on each repeat-all pass keeps a re-drawn bag re-drawn.

The one consequence to accept rather than fix: shuffle can deal the same video
twice in a row. That is what a random draw from a bag with duplicates in it
does, and suppressing it would mean teaching the shuffler about identity for the
first time.

## Open questions

- **Wording for entries-vs-videos** on the card and the track counter — see the
  browse pill section. Needs one phrase picked, then used in three places.
