# Theater-mode jitter — root cause & fix

*Investigated 2026-07-30. Reproduced on the `beryllium` clip (3,954 markers), 143 Hz display.*

## Symptom

In theater mode the bounce-path viewer stuttered roughly twice a second. The video
itself played smoothly — the jitter was localised to the canvas. Frame pacing showed
a clean 6.9 ms median with a long tail: p99 ≈ 35 ms, worst frame ≈ 55 ms, ~18 stalls
over 20 ms in a 12 s window, arriving on a suspiciously regular ~0.56 s cadence.

## Root cause

**3,954 marker rows × 6 elements (~23,700 DOM nodes) were rendered into a sidebar
panel that was `display: none`.**

The BX sidebar tab defaults to `'more'` (`app/watch/page.tsx`, `sidebarTab` state), so
`#sidebarPanelBx` never gets its `.active` class on load and the whole panel is
`display: none`. React still rendered every row into it.

That alone would be inert. The trigger was the per-frame highlight in the engine's
time-update path (`app/watch/page.tsx`, the `mli-` block): it finds the nearest marker
and moves a `.current` class between rows via `classList.add` / `classList.remove`.
Chrome recalculates style for `display: none` subtrees, so each toggle invalidated
style across all ~24k elements. The ~0.56 s cadence was simply how often the nearest
marker changed at that clip's marker density.

**Nothing to do with rendering the path.** `buildPath()` is cached — it runs on `.bx`
load, not per frame. `drawBounceX()` measured 0.40 ms against a 6.94 ms vsync budget.

## The fix

Two changes, both small:

| file | change |
|---|---|
| `app/watch/page.tsx:722` | Gate row rendering on `sidebarTab === 'bx'` — rows only exist while the panel is the active tab. |
| `app/globals.css:1271` | `content-visibility: auto` + `contain-intrinsic-size: auto 31px` on `.marker-list-item`, so the list stays cheap once the panel *is* opened. |

Element count on the watch page: **23,916 → 203**.

## Measured result

Production build, theater mode, engine drawing, video playing, 12 s sample:

| | before | after | empty-page control |
|---|---|---|---|
| elements | 23,916 | 203 | 202 |
| fps | 134.9 | **144.0** | 143.9 |
| p50 | 7.0 ms | 6.9 ms | 6.9 ms |
| p99 | 34.8 ms | **7.1 ms** | 7.1 ms |
| max frame | 55.5 ms | **7.3 ms** | 7.2 ms |
| stalls > 20 ms | 18 | **0** | 0 |
| LoAF entries | 46 | **0** | 0 |
| dropped video frames | 2/900 | **0/822** | — |

The page now costs nothing measurable above a blank document.

## Dead ends (don't re-walk these)

- **The path generator / canvas renderer.** The original hypothesis. `buildPath` is
  cached; `drawBounceX` is 6 % of the frame budget. Every redesign considered on this
  basis — SVG pre-render, tile caching, oversized canvas + CSS transform, WebGL — would
  have been wasted work.
- **Overlay spinners.** Three `video-overlay` elements are hidden with
  `opacity`/`visibility` but stay `display: flex`, so their `infinite` spin animations
  never stop. Real waste, and `animation-play-state: paused` (`app/globals.css:668`)
  fixes it — but it changed the numbers by nothing. Kept as a micro-optimisation only.
- **Timers / observers.** Census found 0 timers, 0 intervals, 5 mutations per 6 s.
- **Header, box-shadows, the canvas itself, the `<video>` element.** A cumulative DOM
  strip cleared all four: removing each left the stall count unchanged at 11.

## How it was found, if it comes back

A **cumulative DOM strip** is what cracked it, after every targeted hypothesis failed:
remove one `<body>` subtree at a time, re-measure rAF pacing for ~6 s at each step.
Stripping everything gave 0 stalls; an element histogram then showed ~23.7k of 23.9k
nodes were marker rows; a two-cell A/B (rows present vs. removed, nothing else changed)
isolated it cleanly:

- rows present — 23,926 els, 135.3 fps, p99 34.7, 13 stalls
- rows removed — 202 els, 143.9 fps, p99 7.1, **0 stalls**

Two process notes worth keeping:

- **Always take an empty-page control.** `/about` at 143.9 fps / 0 stalls is what proved
  the environment and the display were fine and made every later number interpretable.
- **The service worker will serve stale CSS after a rebuild.** A fix appeared not to work
  because the rule was absent from `document.styleSheets` while present on disk.
  Unregister the SW and clear `caches` before trusting a negative result.

## Known remaining behaviour

- **Opening the BX tab mounts all ~4k rows at once**, so expect a one-time hitch on first
  open. `content-visibility` keeps scrolling cheap afterwards. Virtualising the list is
  the real fix if that hitch ever matters — see below.
- **The engine's rAF loop in `lib/player/engine.ts` runs unconditionally forever**, with no
  pause gating. Not the cause of this bug, but it burns a frame's work while paused.
  BX-Editor-FX already gates on a `needsContinuousFrame()` predicate; worth porting.

## Prior art in BX-Editor-FX

The sibling editor repo (`brewswain/BX-Editor-FX`) hit this class of problem first and
solved it harder — its marker list is **virtually scrolled** (~40 rows in the DOM
regardless of marker count) and its nearest-marker highlight only touches rows that are
actually mounted. See `handoffs/performance-optimizations.md` there, section *"Marker
list (critical for many imported markers)"*. If this viewer ever needs more than the
tab gate, that implementation is the reference.
