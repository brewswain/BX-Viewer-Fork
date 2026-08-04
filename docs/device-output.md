# Device output

Drives a stroker — an OSSM, or anything Buttplug supports with positional
control — from the same `.bx` path the waveform is drawn from, in sync with the
video.

Everything runs in the browser. There is no new server, no new dependency, and
no change to the `.bx` format.

---

## How it works

A `.bx` marker pair is a *curve*: "go from depth A to depth B over N frames,
following Godot tween `trans`/`ease`". Essentially no device speaks that. What
they all accept is "be at position P in D milliseconds, travelling linearly".

So the path is converted in three steps (`lib/device/`):

| Step | File | What it does |
|---|---|---|
| `buildSegments` | `plan.ts` | Markers → timed curve segments. Lossless. |
| `linearize` | `plan.ts` | Segments → flat linear moves, subdividing only curves that measurably deviate from a straight line, then merging anything closer together than the device can accept. |
| `StrokeDriver` | `driver.ts` | Issues each move at the right moment against video time, and handles seeking, pausing and falling behind. |
| Transport | `ossmDirect.ts` / `buttplug.ts` / `xtoys.ts` | Puts it on the wire. |

Two consequences worth knowing:

- **The easing you see is the easing the machine gets.** Curves are flattened
  here, using this app's own `godotEase`, so device motion matches the on-screen
  path. This also sidesteps a real incompatibility: OSSM firmware indexes its
  transition enum differently from Godot, so a `.bx` `trans` byte sent raw to an
  OSSM means a *different curve* for 5 of the 8 values. We never send it raw.
- **Command rate stays low.** Across the bundled library, plans run 3–8
  commands/second with a peak around 11/s, and planning a full track costs
  1–2 ms.

The driver is called from the engine's per-frame callback and is O(1) when no
command is due, so it adds nothing measurable to the render loop.

---

## Setup

Open **Settings → Device output (OSSM)**, tick *Enable device output*, and pick
a connection.

### Option A — the OSSM raw, via the MCP bridge (default)

OSSM Sauce → Bridge Settings → Bridge Mode: `MCP` → Enable. That is all of it.

`POST /send_binary` hands hex straight to the ESP32 without looking at it
(`websocket_mcp_bridge.gd:47`), so we assemble the firmware's own `SMOOTH_MOVE`
frame and pick the transition byte ourselves. Neither of the two settings below
applies — there is no duration clamp and no smoothing override on this path, and
so nothing to set by hand each launch. It is also the only route that can report
whether the OSSM is *actually* attached, which it does via `POST /status`.

The catch is the transport: a hand-rolled TCP server that handles one request
per connection and hangs up. On loopback at 3–8 commands a second that is fine,
but it is why moves are coalesced rather than queued, and why this is HTTP where
the others are WebSockets.

Default server: `http://127.0.0.1:8081`.

The firmware still enforces what should be enforced — depth 0..10000 is mapped
into the user's configured range limit and duration is floored at 20 ms
(`main.cpp:283`). This is the same command the bridges send, with the fields we
care about left alone.

### Option B — Intiface Central (Buttplug)

Works with any Buttplug device that supports positional control. To reach an
OSSM this way, the OSSM Sauce app registers itself with Intiface as a TCode
device:

1. Intiface Central → App Modes → Show Advanced Settings → enable
   **Device Websocket Server**.
2. Devices → Websocket Devices → Add, protocol `tcode-v03`, name `ossm`.
3. Start Intiface's server.
4. In OSSM Sauce, Bridge Settings → Bridge Mode: `Buttplug.io` → Enable.
5. **Set Bridge Settings → Speed Overrides → Minimum Duration to about 50 ms.**
6. **Set Stroke Smoothing to `Linear`.** See below.

Default server: `ws://127.0.0.1:12345`.

### Option C — OSSM Sauce's XToys bridge

Skips Intiface, but still goes through OSSM Sauce's rewriting.

1. OSSM Sauce → Bridge Settings → Bridge Mode: `XToys` → Enable.
2. Tick **Get stroke duration from command**. Without it every stroke is forced
   to `1000 / Max Message Frequency` ms — 250 ms at the default 4/sec — and our
   timing is discarded. With it ticked, Max Message Frequency is unused: it is
   only a duration fallback, not a rate limiter, and nothing is dropped.
3. Set **Speed Overrides → Minimum Duration** to about 50 ms, as above.
4. Set **Stroke Smoothing** to `Linear`, as above.

Default server: `ws://127.0.0.1:8080`.

This bridge sends nothing back, so the viewer can tell that OSSM Sauce is
running but *not* whether the OSSM itself is connected. It also silently drops
every command while the OSSM is disconnected from the app.

### The two OSSM Sauce settings that matter

These apply to options B and C only. Both of those bridges pass every move
through the same clamp and the same smoothing; option A bypasses both, which is
the reason it is the default.

**Minimum Duration** defaults to **500 ms** and clamps every incoming stroke, so
a path with 100 ms moves gets stretched 5× and the machine falls steadily behind
the video. It lives in `UserSettings.cfg` under `[bridge_settings]` and is
remembered between launches.

**Stroke Smoothing** defaults to **Sine**, and both bridges apply it — with
ease-in-out — to every move they forward. We have already flattened the curve
into short linear steps, so re-easing each step makes the machine decelerate to a
stop and restart several times a second: the path pulses instead of flowing.
`Linear` hands the machine exactly the motion that is on screen. This one is
*not* persisted — OSSM Sauce resets it to Sine on every launch.

### Then

Open a video. The **Device** panel is at the top of the *BounceX Data* sidebar
tab: connect there, and the indicator goes solid teal once it is actually
driving. Enable *Connect automatically* in settings to skip the manual step.

---

## Settings

| Setting | Notes |
|---|---|
| Enable device output | Master switch. Off by default — opening a page should never start hardware. |
| Connect automatically | Connects when a player page opens. |
| Invert direction | Swaps the ends of the stroke. |
| Stroke range | Limits how much of the machine's travel the path uses, as a percentage. |
| Sync offset | Positive delays the device, negative makes it lead. For mechanical lag. |
| Minimum move | Commands closer together than this are merged. Raise it if the device stutters or falls behind. |

Range, invert and offset apply to the next command sent — no reload needed.
Changing *Minimum move* replans, which is why it is the one that costs anything.

---

## Testing without hardware

`scripts/buttplug-sim.ts` is a fake Buttplug server that pretends to be Intiface
with one linear device attached, and prints every move it receives:

```
bun run sim                    # ws://127.0.0.1:12345
bun run sim -- --port 47000    # somewhere else
bun run sim -- --gap 50        # emulate a device with a 50 ms timing gap
```

```
[·············●··························] pos 0.325  over   180ms    164ms since
[························●···············] pos 0.610  over   320ms    180ms since
```

Stop Intiface Central first, or pass `--port` — they cannot share 12345.

The same simulator backs the test suite (`bun test`), which covers the planning
maths, the scheduler, the wire protocol over real sockets, and the whole chain
end to end.

---

## Known limits

- **Buttplug message spec v3.** Intiface 3.1 runs a v4 server but translates for
  older clients, and OSSM Sauce's own bridge connects as v3, which makes it the
  verified-compatible choice. Moving to v4 would mean replacing `LinearCmd` with
  `OutputCmd` and reading per-feature integer ranges out of `DeviceList`.
- **Positional devices only.** A vibration-only toy connects and is listed, but
  nothing drives it; there is no stroke-rate-to-intensity fallback.
- **One device at a time** — the first one that reports linear support.
- **The MCP route is OSSM-only and one-way per command.** It has no reply
  channel beyond `/status`, and it assumes the firmware's command set, so it is
  not a general transport the way the Buttplug one is.
- **`playbackRate` is not handled.** The player never changes it, and the
  engine's own smoothed clock does not track it either.
- **Served over https**, `ws://127.0.0.1` still works in Chrome and Firefox
  (loopback is a secure context; Chrome 147+ may show a Local Network Access
  prompt) but is blocked outright in Safari. Over `http://localhost`, as this app
  normally runs, none of that applies.
