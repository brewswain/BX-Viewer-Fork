import json
import argparse
from pathlib import Path
from typing import Dict, List, Tuple

# Godot TransitionType / EaseType, the same ints `.bx` stores in each marker.
TRANS_NAMES = {
    'linear': 0, 'sine': 1, 'quint': 2, 'quart': 3, 'quad': 4, 'expo': 5,
    'elastic': 6, 'cubic': 7, 'circ': 8, 'bounce': 9, 'back': 10, 'spring': 11,
}
EASE_NAMES = {'in': 0, 'out': 1, 'inout': 2, 'outin': 3}


def convert(
    actions: List[dict],
    fps: int,
    trans: int,
    ease: int,
    inverted: bool,
    scale: float,
) -> Tuple[Dict[str, list], List[tuple]]:
    """
    Funscript actions -> `.bx` markers.

    Both formats measure the same thing from the same end: funscript `pos` 100
    and `.bx` depth 1.0 are each the top of the stroke range, so the mapping is
    a plain pos/100 with no flip. Funscript carries no easing, hence the caller
    picking one `trans`/`ease` for every marker.
    """
    markers: Dict[str, list] = {}
    collisions: List[tuple] = []

    for action in sorted(actions, key=lambda a: a['at']):
        frame = round(action['at'] * fps / 1000)
        depth = action['pos'] / 100.0
        if inverted:
            depth = 1.0 - depth
        depth = round(min(1.0, max(0.0, depth * scale)), 6)

        key = str(frame)
        if key in markers:
            collisions.append((frame, action['at'], markers[key][0], depth))
        markers[key] = [depth, trans, ease, 0]

    ordered = {str(k): markers[str(k)] for k in sorted(map(int, markers.keys()))}
    return ordered, collisions


def dump_bx(meta: dict, markers: Dict[str, list], v1: bool) -> str:
    """One marker per line — json.dump would either minify or explode each
    4-element tuple across 6 lines."""
    if v1:
        body = markers
        lines = ['{']
        indent = '  '
    else:
        lines = ['{', '  "meta": ' + json.dumps(meta, indent=2, ensure_ascii=False).replace('\n', '\n  ') + ',', '  "markers": {']
        indent = '    '

    keys = list(markers.keys())
    for i, k in enumerate(keys):
        values = ', '.join(repr(v) if isinstance(v, float) else str(v) for v in markers[k])
        comma = ',' if i < len(keys) - 1 else ''
        lines.append(f'{indent}"{k}": [{values}]{comma}')

    if not v1:
        lines.append('  }')
    lines.append('}')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(
        description='Convert a .funscript (or funscript-shaped .json) into a .bx path')
    parser.add_argument('input_file', help='Path to the input .funscript / .json file')
    parser.add_argument('-o', '--output',
                        help='Output .bx path (default: input name with .bx)')
    parser.add_argument('--trans', default='linear', choices=sorted(TRANS_NAMES),
                        help='Godot transition curve for every marker (default: linear, '
                             'which reproduces funscript playback exactly)')
    parser.add_argument('--ease', default='in', choices=sorted(EASE_NAMES),
                        help='Godot ease type for every marker (default: in; '
                             'ignored when --trans is linear)')
    parser.add_argument('--fps', type=int, default=60,
                        help='Frame rate the .bx frame numbers are in (default: 60)')
    parser.add_argument('--v1', action='store_true',
                        help='Emit a bare v1 marker map instead of the v2 meta/markers wrapper')

    args = parser.parse_args()

    in_path = Path(args.input_file)
    if not in_path.exists():
        print(f"Error: Input file '{in_path}' not found")
        return
    out_path = Path(args.output) if args.output else in_path.with_suffix('.bx')

    with open(in_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    actions = data.get('actions')
    if not actions:
        print(f"Error: '{in_path}' has no 'actions' array — is it a funscript?")
        return

    # `range` caps the usable span of pos; `inverted` flips which end is which.
    fs_range = data.get('range', 100)
    scale = (fs_range / 100.0) if isinstance(fs_range, (int, float)) and fs_range > 0 else 1.0
    inverted = data.get('inverted') is True

    trans = TRANS_NAMES[args.trans]
    ease = EASE_NAMES[args.ease]

    markers, collisions = convert(actions, args.fps, trans, ease, inverted, scale)

    meta = {'version': 2, 'marker_fields': ['depth', 'trans', 'ease', 'auxiliary']}
    metadata = data.get('metadata') or {}
    for src, dst in (('title', 'title'), ('creator', 'path_creator'), ('video_url', 'video_url')):
        if metadata.get(src):
            meta[dst] = metadata[src]

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(dump_bx(meta, markers, args.v1))

    frames = sorted(map(int, markers.keys()))
    depths = [v[0] for v in markers.values()]
    print(f"Created {out_path}")
    print(f"  actions in:  {len(actions)}")
    print(f"  markers out: {len(markers)}")
    print(f"  frames:      {frames[0]}-{frames[-1]} "
          f"({frames[-1] / args.fps:.2f}s @{args.fps}fps)")
    print(f"  depth:       {min(depths)}-{max(depths)}"
          f"{' (inverted)' if inverted else ''}"
          f"{f' (range {fs_range})' if scale != 1.0 else ''}")
    print(f"  curve:       {args.trans}/{args.ease} ({trans}/{ease})")

    # Two actions can land on one frame at 60fps if they are <17ms apart; the
    # later one wins, so say so rather than silently dropping strokes.
    if collisions:
        print(f"  WARNING: {len(collisions)} frame collision(s) — later action kept:")
        for frame, at, prev, kept in collisions[:10]:
            print(f"    frame {frame} (at={at}ms): {prev} overwritten by {kept}")
        if len(collisions) > 10:
            print(f"    ... and {len(collisions) - 10} more")


if __name__ == "__main__":
    main()
