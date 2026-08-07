# bx2 text effects — editing reference

How to make custom text pop up over a `.bx` path. The viewer only *renders*
effects — they are authored either in
[BX-Editor-FX](https://github.com/Alunacoz/BX-Editor-FX) or by hand in the `.bx`
JSON, which is what this doc covers. The worked example in this repo is
`videos/bouncex-dildo-hero-luna-s-edition/` (35 text effects, custom font).

Renderer: `lib/player/engine.ts` (the `Text effects (bx2)` block).
Fade maths: `getEffectFadeAlpha` in `lib/player/format.ts`.
Font loading: `loadEffectFonts` in `lib/player/bx.ts`.

## File shape

A v1 `.bx` is a bare marker map. A v2 file wraps it and adds `effects`:

```json
{
  "meta": { "version": 2, "title": "…", "path_creator": "…", "bpm": 130 },
  "markers": { "0": [50, 0, 0], "120": [80, 1, 2] },
  "effects": [ /* … */ ]
}
```

`parseBx` (`lib/player/bx.ts`) accepts `meta.version: 2` **or** a root-level
`version: 2`. Anything without a version 2 marker is read as a flat v1 marker map
and its `effects` are ignored — that is the usual reason a new effect renders
nothing.

## The text effect

```json
{
  "id": "e1",
  "type": "text",
  "layer": 1,
  "startFrame": 0,
  "endFrame": 493,
  "text": "Read the description for the rules/info!",
  "font": "LilitaOne-Regular",
  "fontSize": 50,
  "color": "#ffffff",
  "opacity": 1,
  "fadeIn": 30,
  "fadeOut": 30,
  "posX": 50,
  "posY": 50,
  "strokeWidth": 5
}
```

| Field | Meaning |
| --- | --- |
| `type` | `"text"`. Also valid in the same array: `"pathColor"`, `"pathSpeed"`. |
| `startFrame` / `endFrame` | Frames at **60 fps** (`FPS`, `lib/player/constants.ts`). Seconds × 60. |
| `fadeIn` / `fadeOut` | Fade length **in frames**, measured in from each end. Overlapping fades just clamp. |
| `text` | `\n` gives real multi-line. Lines auto-shrink together if the widest overflows 92% of the canvas width. |
| `font` | Family name. Built-ins need no file; anything else needs a font file (below). |
| `fontSize` | Percent of the **path-area height**, not pixels — so it scales with zoom and overlay mode. |
| `posX` | Percent of canvas width. 50 = centered; text is always center-aligned around this point. |
| `posY` | Percent of the path-area height, from its top. 50 = vertically centered. |
| `color` / `opacity` | Fill and base alpha. `opacity` multiplies the fade alpha. |
| `strokeWidth` / `strokeColor` | Outline. Width is relative (`w / 100 × fontSize × 2`), so `5` is a modest outline at any size. Omit or `0` for none. |
| `id`, `layer` | Carried through but not used by the renderer. Keep them unique/sane for your own sanity when editing. |

Every field except `type`, `startFrame`, `endFrame` has a default: white
`sans-serif`, `fontSize` 50, centered, opaque, no stroke, no fade.

## Custom fonts

Put the font file **in the video's own folder**, named exactly the same as the
`font` value. Luna's edition ships `LilitaOne-Regular.ttf` for
`"font": "LilitaOne-Regular"`.

Extensions tried, in order: `woff2`, `woff`, `ttf`, `otf`. A miss is silent and
falls back to `JetBrains Mono` / `sans-serif`. These names are treated as
built-in and never fetched: `sans-serif`, `serif`, `monospace`, `cursive`,
`fantasy`, `system-ui`, `Arial`, `Georgia`, `Impact`, `Trebuchet MS`,
`Courier New`, `Verdana`, `Times New Roman`, `JetBrains Mono`, `Rajdhani`.

## Frame maths

At 60 fps:

| Time | Frames |
| --- | --- |
| 0.5 s | 30 |
| 1 s | 60 |
| 2 s | 120 |
| 5 s | 300 |
| 10 s | 600 |
| 1 min | 3600 |

One beat at BPM *b* is `3600 / b` frames — at 130 BPM, ~27.7 frames; a bar of 4
is ~111.

## Poppers cue sequence (inhale / hold / exhale)

The pattern for a breathing cue: three back-to-back effects sharing a position,
each fading into the next. Frames below are a 12-second cycle starting at frame
1800 (00:30) — 4 s inhale, 4 s hold, 4 s exhale.

```json
{
  "id": "pop1-in",
  "type": "text",
  "startFrame": 1800,
  "endFrame": 2040,
  "text": "INHALE",
  "font": "Impact",
  "fontSize": 60,
  "color": "#67e8f9",
  "fadeIn": 20,
  "fadeOut": 20,
  "posX": 50,
  "posY": 30,
  "strokeWidth": 6,
  "strokeColor": "#000000"
},
{
  "id": "pop1-hold",
  "type": "text",
  "startFrame": 2040,
  "endFrame": 2280,
  "text": "HOLD",
  "font": "Impact",
  "fontSize": 60,
  "color": "#ffffff",
  "fadeIn": 20,
  "fadeOut": 20,
  "posX": 50,
  "posY": 30,
  "strokeWidth": 6,
  "strokeColor": "#000000"
},
{
  "id": "pop1-out",
  "type": "text",
  "startFrame": 2280,
  "endFrame": 2520,
  "text": "EXHALE",
  "font": "Impact",
  "fontSize": 60,
  "color": "#f0b429",
  "fadeIn": 20,
  "fadeOut": 20,
  "posX": 50,
  "posY": 30,
  "strokeWidth": 6,
  "strokeColor": "#000000"
}
```

Notes on tuning this shape:

- **Butt the segments** (`endFrame` of one == `startFrame` of the next) and give
  each a fade. The outgoing fade-out and incoming fade-in overlap in time only if
  you overlap the frame ranges; butted segments cross-cut cleanly instead, which
  reads better for a hard cue.
- **Keep `posY` off 50** if the path ball crosses the middle — 30 sits the text
  in the upper third and stays out of the waveform.
- **A countdown** is just more segments: `"3"`, `"2"`, `"1"` at 60 frames each.
- **Repeat the cycle** by adding 720 (12 s) to every frame number for the next
  round; a small script beats hand-editing past three or four repeats.
- Use a stroke on anything drawn over video — the renderer only adds a soft
  shadow otherwise, which disappears on bright frames.

## Gotchas

- Text is drawn on the **bx canvas**, not the video. In theater/overlay mode the
  strip sits over the picture, which is where it reads as "text over the video."
  With the strip below the video it stays inside the strip.
  Luna's video file is named `…NoOverlay.mp4` for exactly this reason: the source
  has no burned-in text so the effects supply it.
- Settings → **Text overlays** (`effectsTextEnabled`) hides all of them globally.
  Check that before debugging a missing effect.
- Frames are on the **path** timeline, so `meta.json`'s `offset` shifts them with
  the path. Watch page reads `offset` as milliseconds, playlist as seconds — a
  legacy split, see `lib/player/types.ts`.
- Effects past `endFrame` of the path still render if they're in range; nothing
  clamps them to the marker data.
- `.bx` files are plain JSON — a trailing comma or smart quote from a word
  processor makes the whole file fail to parse, and the player then shows no path
  at all, not just no text.
