# Handoff: BX Viewer performance audit, round two (on the Intel MacBook)

Written 2026-09-26 from a Windows session. The Windows machine holds this project's Claude memory; the Mac session starts without it, so everything it needs is in this file. Repo: `brewswain/BX-Viewer-Fork` (public fork), branch `main`.

## Goal

Measure and fix real performance problems on the **Intel MacBook Pro (~2020, Touch Bar, pre-Apple-silicon)**. This is the performance target. The Windows dev box does not reproduce the problems this machine has, so numbers from Windows don't count.

## First steps

1. `git pull` on main. Launch the **production** build with `./StartWebsite.sh` (it runs `bun run start` through `scripts/next.ts` on port 8000). Measure production, not `next dev`.
2. Open the app once after pulling. `public/sw.js` is now a kill-switch stub: it wipes the old service worker's caches, unregisters it, and reloads open tabs. That first load retires the old worker on this machine. **After that**, delete `public/sw.js` and the `/sw.js` headers block in `next.config.ts`, then commit. (The Windows side was only waiting on this Mac load.)
3. Check browser config before blaming the app. See `PLAYBACK-TUNING.md` at the repo root:
   - **Firefox media cache prefs** were set on Windows (2026-09-03) but were **never set on this MacBook**. Without them, long 1440p60 files stall once Firefox's shared 500 MiB media cache fills. The signature is that everything is idle: no disk reads, no server CPU, Firefox near 0%. Set the three `about:config` prefs from that doc first, or stalls will look like app bugs.
   - The section "macOS: also check hardware decoding". Software decode on this Intel Mac has the opposite signature: high CPU while frames are still being presented.

## Test matrix (record every cell)

Use the same clip, the same position and the same run length in every mode. A long 1440p60 file is the worst case. Record which browser and version you used.

| # | Mode | Why |
|---|------|-----|
| A | Theater mode, normal browser window | Baseline for in-page compositing |
| B | **Theater mode with the browser window in macOS full screen** (the green traffic-light button on the browser window itself) | The user asked for this case specifically. The video is still composited in the page, just at full-screen size and on its own Space. Write down whether the window was full screen (click) or zoomed (Option-click). |
| C | Player fullscreen (the viewer's own fullscreen control, element fullscreen) | Puts the video on its own layer |
| D | Normal (non-theater) watch page | Reference |

**How to read it:** in 2026-08 on this machine, fullscreen (C) was smooth while theater (A) dropped frames on the same clip. That pair separates page compositing from decode: canvas size, rAF loop and decode path are the same, but fullscreen gives the video its own layer. So: A or B bad while C is fine means a compositing problem in the page. All bad means decode or the network. If B is worse than A, suspect the size-dependent cost: a bigger theater box, a larger canvas at Retina scale, or the overlay-plane rules below.

Useful numbers per cell: `document.querySelector('#mainVideo').getVideoPlaybackQuality()` (dropped/total frames, read before and after a fixed 60 s window), CPU and GPU in Activity Monitor, and a DevTools / Firefox Profiler trace of a few seconds to see frame pacing (median and p99 frame time, plus the count of frames over 20 ms).

## Hard rule from the last regression

**Never put a CSS `transform`, `filter`, or `opacity` animation on `#mainVideo`.** On Intel Macs a transformed `<video>` loses the hardware overlay plane, so every decoded frame becomes a composited texture. That was the 2026-08-18 theater regression: `applyTheaterFit` used `transform: scale()`. Theater's anamorphic fit is now an explicit width/height box plus `object-fit: fill` in `lib/player/engine.ts` (`applyTheaterFit`). If something needs to warp the picture, resize the box. Theater fit caps default to stretch 1.3 / zoom 1.0 and can be tuned live with Shift+F (session-only; the settings page owns the saved default).

## Prior perf work (read, don't redo)

- `docs/theater-mode-jitter.md`: the 2026-07-30 canvas stutter, caused by ~24k hidden marker DOM nodes getting style recalcs. It's fixed by windowing (`lib/player/markerWindow.ts`).
- Commits `ffadc03` and `1a202a4` (2026-09-05, "performance upgrades"): seek preview, `lib/serveFile.ts`, the `/api/library` endpoint, capped duration probes, engine changes. Diff them for context.
- Since then, browse paginates at 24 cards per page (`455612b`), and the queue and radio were added (`lib/queue/`, `components/queue/`, `QueueSession` mounted in `app/layout.tsx`).

## Open perf issues, probably already fixed

The audit filed issues 1-18 in priority order on 2026-08-30. The only two labelled `perf`:

- **#17** "Watch page fetches every meta.json in the library to show 5 suggestions". The current code (`app/watch/page.tsx`, the More Videos effect) uses a single `/api/library` request, so it looks fixed.
- **#18** "VideoCard duration probe fires per card". The current `components/browse/VideoCard.tsx` returns early when a duration is cached and sends probes through `queueProbe` (capped), so it looks fixed too.

Both issues are still **open**. Confirm each fix on the Mac (Network panel on browse and watch), then **ask the user before closing or commenting**. The repo is public, and nothing gets filed or closed without asking.

## Leads worth measuring

- **Playlist page still fans out**: `app/playlist/page.tsx` (around lines 95 and 237) fetches one `meta.json` per folder. That's the same pattern #17 described. On a big playlist it competes with the first media range requests (HTTP/1.1 allows about 6 sockets per origin). This is a candidate for `/api/library` or a playlist-scoped endpoint. Its cost hasn't been measured.
- Time to first frame and seek latency on multi-GB files (served by `lib/serveFile.ts`, which uses pull-based streams).
- Browse grid: first paint and page flips at 24 per page with the full library. The library is about 114 GB (489 files), much bigger than the 58 videos the issues assumed.
- Queue player and radio: extra fetches or re-renders during playback (the watch page tops up radio while the current row plays).
- Playback-rate interactions: the engine's rAF loop integrates `smoothTime` using `video.playbackRate`, and `StrokeDriver.tick` divides its durations by that rate (`lib/player/playbackRate.ts`). Don't break either one while optimising the loop.

## Working conventions for this repo

- **Commit and push straight to `main`.** No feature branches: the MacBook runs by pulling main.
- No `Co-Authored-By: Claude` trailer on commits, and no Claude footer on PR text.
- No em dashes in anything written (comments, commits, docs, chat).
- Comments are terse by default: explain why, not what.
- Artifacts are titled `BX Viewer · <Name>`.
- New npm deps: the Windows checkout is on exFAT and can't rewrite `bun.lock`, so avoid deps unless they're really needed. A Mac (APFS) checkout can refresh the lockfile if one is truly required.
- Don't open GitHub issues without asking.

## Not part of this task (context only)

- The library sync from Windows to the Mac (Syncthing: `bx-videos` and `bx-playlists` are send-only on Windows) is mid-setup and waiting on the Mac pairing. The perf audit doesn't depend on it; the hand-copied library on the Mac is fine to measure with. Tags differ until the sync lands, and tags don't affect performance.
- Queued after this: a user-style feature audit, deduped against issues 1-18.

## Report back

End with a short summary covering the A-D matrix numbers, the fixes you committed, which of #17 and #18 you confirmed fixed, and anything you left open. Offer to publish it as a `BX Viewer · Perf Audit (Mac)` artifact. The user will relay the result to the Windows session so its memory can be updated.

## Suggested skills (use them if the Mac session has them)

- `diagnose` / `mattpocock-skills:diagnosing-bugs`: reproduce, minimise, hypothesise, instrument, fix, regression-test, for each regression you find.
- `run`: launch the app and confirm a change works in the real app.
- `claude-in-chrome` / `anthropic-skills:chrome-browser`: only if you're testing in Chrome. Firefox is the primary browser.
- `code-review` at medium before each push.
- `artifact-design`: for the final summary artifact.
