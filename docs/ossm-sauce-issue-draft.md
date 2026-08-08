> **Draft — not filed.** This is an issue written *for someone else's repo* and
> never posted. It is kept here so the argument isn't lost. Nothing in this
> project depends on it; see `HANDOFF.md` and `docs/ossm-bxpl-v2-handoff.md` for
> what shipped instead. If it does get filed, record the issue number here and in
> the two docs that currently say it hasn't been raised.

# Let a v2 playlist decline to state `shuffle`/`loop`, the way it can already decline to state `video_offset_ms`

**Repo:** clbhundley/OSSM-Sauce
**Files:** `ossm-sauce-app/scripts/playlist_format.gd`

## What happens now

`_parse_v2` returns `has_flags: true` unconditionally (`playlist_format.gd:135`), and reads
the two flags with a `false` default:

```gdscript
return {
	"entries": entries,
	"shuffle": data.get("shuffle", false) == true,
	"loop": data.get("loop", false) == true,
	"has_flags": true,
	...
}
```

`apply_playlist` then honours `has_flags` as permission to write the user's toggles
(`ossm_sauce.gd:1019-1022`):

```gdscript
# Legacy files carry no flags; leave the user's current toggles alone.
if parsed["has_flags"]:
	shuffle_enabled = parsed["shuffle"]
	loop_playlist = parsed["loop"]
```

So a v2 file that simply omits both keys is indistinguishable from one that deliberately
asserts `shuffle: false, loop: false`, and loading it turns both toggles off.

## Why it matters

Legacy v1 files can express "this playlist has no opinion about shuffle and loop" — that is
exactly what `has_flags: false` is for, and the comment above says so. v2 cannot. Any tool
that writes v2 must therefore either take ownership of two settings it may know nothing
about, or stay on v1 forever and give up per-entry repeat modes and `video_offset_ms`.

That is the position I'm in writing v2 `.bxpl` files from an external exporter: I have
entries and their order, and no basis whatsoever for an opinion about the user's shuffle
toggle. Right now the only honest option is to keep emitting v1.

## The precedent

`video_offset_ms` already works the way I'm asking for. Its docstring
(`playlist_format.gd:73-76`):

> `video_offset_ms` is null unless the file carried one

and `apply_playlist` (`ossm_sauce.gd:1013-1017`):

```gdscript
# The playlist's offset overrides the one load_path just read out of the
# .bx: it is the later statement about this entry, made when the user
# saved it. A playlist that carries none leaves the file's own value be.
if entry.get("video_offset_ms", null) != null:
	set_entry_video_offset(entries.size() - 1, entry["video_offset_ms"])
```

Absent means "no statement", `0` means "the top of the video", and the two are modelled as
`null` vs a value precisely so they cannot be confused. The flags want the same treatment.

## Suggested change

In `_parse_v2`, derive `has_flags` from what the file actually carried:

```gdscript
var has_flags: bool = data.has("shuffle") or data.has("loop")
return {
	"entries": entries,
	"shuffle": data.get("shuffle", false) == true,
	"loop": data.get("loop", false) == true,
	"has_flags": has_flags,
	...
}
```

No caller changes: `apply_playlist` already branches on `has_flags` correctly, and
`serialize` still writes both keys every time, so every file the app itself saves keeps
behaving exactly as it does today.

A file carrying only one of the two is the one genuinely new case. The snippet above treats
it as "flags present" and defaults the missing one to `false`. Reading each independently
would be more faithful but needs two flags rather than one in the returned dictionary — happy
to write it whichever way you prefer.

## Compatibility

`VERSION` should stay at **2**. A flag-less v2 file on a build without this change reads as
`shuffle: false, loop: false` and clobbers, which is exactly today's behaviour and no worse;
bumping the version would instead make those builds refuse the playlist outright.

I'm happy to open a PR with the change and a test if the approach looks right.
