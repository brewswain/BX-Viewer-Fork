# Playback tuning: browser buffering for multi-GB videos

Per-machine browser settings that the repo cannot set for you. Apply these once on each machine
that plays the library (Windows desktop, the MacBook). Nothing here is app configuration; it is all
browser configuration, because the limits involved sit below anything a page can control.

## The problem this solves

Firefox keeps **one** fixed-size media cache shared by every tab and every `<video>` on the machine.
The default is 500 MiB. That is not 500 MiB per video, it is 500 MiB total.

Divide that by a real file from this library:

```
longform7-full.mp4   h264 High, 2560x1440@60, 9.85 Mbps, 82.8 min, 5.78 GB
500 MiB / 9.85 Mbps  =  426 seconds  =  7.1 minutes
```

So the entire global cache holds about seven minutes of one video. Two further defaults cap it
harder: Firefox buffers only `media.cache_readahead_limit` seconds ahead (60) and then deliberately
**suspends the connection**, resuming when the buffer drains below `media.cache_resume_threshold`
(30). `preload="auto"` does not override either one, so 60 seconds is the real ceiling no matter
what the player asks for.

Two things go wrong as a result. Ordinary playback jitters, because the cache thrashes and every
backwards seek is a fresh network fetch. And occasionally it wedges permanently: the cache fills,
no block is evictable because a reader still needs it, and the reader waits on a block that never
frees. Playback stops dead with "Buffering…" forever.

## Recognising the wedge

The tell is that **everything is idle**. A slow network or a slow disk looks busy; this looks dead.

- Video sits on "Buffering…" and never advances, often only seconds in.
- The drive holding the videos shows **0 KB/s reads**.
- The `next start` server shows **no CPU movement**.
- Firefox settles to ~1% CPU after an initial burst.
- The media cache temp file is pinned at its cap with a **last-write time hours old**.

If instead the server is busy and the disk is reading, this is not your problem; look at the file
or the network.

Check the cache file directly.

macOS:

```sh
ls -lh "$TMPDIR"/mozilla-temp-* 2>/dev/null
```

Windows (PowerShell):

```powershell
Get-ChildItem "$env:TEMP\mozilla-temp-files" -Force |
  Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
```

A file sitting at ~500 MB whose `LastWriteTime` is hours in the past is the wedge. The immediate
unstick is a hard reload (`Cmd+Shift+R` / `Ctrl+Shift+R`); the cache only releases when the media
elements are torn down. The settings below are what stop it recurring.

## Firefox settings

Same prefs on macOS and Windows. Open `about:config`, accept the warning, search each name, set the
value. Restart Firefox afterwards.

| Pref | Default | Set to | Why |
| --- | --- | --- | --- |
| `media.cache_size` | `512000` | `8388608` | Cache size in **KB**. 8 GB holds a whole longform file rather than seven minutes of one. |
| `media.cache_readahead_limit` | `60` | `36000` | Seconds to buffer ahead before suspending the connection. High enough to mean "keep going". |
| `media.cache_resume_threshold` | `30` | `36000` | Seconds of remaining buffer that trigger a resume. Must not sit far below the readahead limit or the connection stays suspended. |

Set the resume threshold to the same value as the readahead limit. If resume is much lower, Firefox
suspends at the ceiling and then waits for a long drain before fetching again, which reintroduces
the stall it was suspending to avoid.

`media.cache_size` is a **disk** cache in the temp directory, not RAM, so 8 GB costs temp space
rather than memory. Confirm the volume backing the temp dir has room to spare before setting it;
on macOS that is the system volume.

### Verifying it took

Play a longform file for a minute, then re-run the `ls` / `Get-ChildItem` above. The temp file
should now grow past 500 MB and its `LastWriteTime` should track the current time while playback
continues. That is prebuffering working.

## macOS: also check hardware decoding

The Intel MacBook is the performance target for this app, and 1440p60 H.264 in software decode will
saturate it on its own, independently of any buffering problem. Open `about:support` and search the
page for `Media`. Under the decoder listing, confirm playback is not falling back to a software
decoder, and check that `media.hardware-video-decoding.failed` is `false` in `about:config`.

If hardware decoding has failed, buffering settings will not rescue it. That is a separate fault
with its own symptom: sustained high CPU and fan noise **while frames are being presented**, rather
than the idle stall described above.

## Chrome and Safari

The prefs above are Firefox-only.

Chrome has no equivalent user-facing setting. It sizes its media cache from available disk and does
not expose a knob, so there is nothing to replicate; it also does not exhibit the wedge in the same
way.

Safari buffers per media element with no shared global cap, so it does not hit this limit either.
Its constraint is different: it is stricter about byte-range semantics, which is why the server side
below matters.

## Server side (already in the repo, no action needed)

Recorded here so the browser settings are not mistaken for the whole fix.

`lib/serveFile.ts` sends `Cache-Control: no-cache` on media, not `no-store`. Those sound
interchangeable and are not. `no-store` forbids the browser from retaining **anything**, so every
byte it re-reads has to come off the network again, and 100% of the buffering burden lands on the
fixed-size media cache described above. `no-cache` permits storage and asks only for revalidation.

To make that revalidation cheap, `serveFile` emits an `ETag` derived from size and mtime, answers
`If-None-Match` with a `304`, and honours `If-Range` so that a file replaced mid-stream cannot be
stitched together from two different versions.

`public/sw.js` passes all video requests straight through to the network, Range or not. Do not
change this. A service worker that intercepts Range requests corrupts the responses and breaks
seeking, and caching a non-range response for a 10+ GB file clones the entire body.
