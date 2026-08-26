#!/usr/bin/env python3
"""Read a W/B/+/- string from stdin, write SVG to stdout.

Usage: echo 'W+WBBW+W 5 2 2 0 0 1,0/ 1,3\' | ./threat2svg.py > out.svg
"""
import sys
from math import ceil, floor
from xml.sax.saxutils import escape

LONG = 12
SHORT = 6
MARGIN = 10
STROKE = 1.5
LABEL_X = 15
LABEL_Y = -5
LABEL_SIZE = 6
TICK = 3   
END_SHIFT = STROKE / 4
ARROW = [((-11, 0), (-3, 0)),    # shaft   } direction arrow before the
         ((-7, -3), (-3, 0)),    # barbs   } start, in glyph-local coords
         ((-7, 3), (-3, 0))]
CAPTION_SIZE = 8
CAPTION_GAP = 6 


def main():
    data = sys.stdin.read()
    parts = data.split(None, 1)
    prog = parts[0] if parts else ''
    caption = parts[1].strip() if len(parts) > 1 else ''

    x, y = 0, 0
    dx, dy = 1, 0            # heading right
    path = [(x, y)]          # one continuous polyline (pen never lifts)
    diagonals = []           # extra segments from B
    labels = []              # (x, y, char) from lowercase suffixes
    ticks = []               # junction marks between same-direction glyphs

    def forward(n):
        nonlocal x, y
        x += dx * n
        y += dy * n
        path.append((x, y))

    def right():
        nonlocal dx, dy
        dx, dy = -dy, dx

    def left():
        nonlocal dx, dy
        dx, dy = dy, -dx

    def glyph(cross, label=None):
        if label is not None:
            # local (LABEL_X, LABEL_Y): x-axis = heading, y-axis = 90 deg right
            lx = x + dx * LABEL_X - dy * LABEL_Y
            ly = y + dy * LABEL_X + dx * LABEL_Y
            labels.append((lx, ly, label))
        pts = []
        forward(LONG);  pts.append((x, y))    # local (12,0)
        right()
        forward(SHORT); pts.append((x, y))    # local (12,6)
        left()
        forward(SHORT); pts.append((x, y))    # local (18,6)
        left()
        forward(SHORT); pts.append((x, y))    # local (18,0)
        right()
        forward(LONG)                         # local (30,0)
        if cross:
            diagonals.append((pts[0], pts[2]))   # (12,0)-(18,6)
            diagonals.append((pts[1], pts[3]))   # (12,6)-(18,0)

    def tick_at(cx, cy, tdx, tdy):
        ticks.append(((cx + tdy * TICK, cy - tdx * TICK),
                      (cx - tdy * TICK, cy + tdx * TICK)))

    i = 0
    prev_dir = None          # heading at the end of the previous glyph
    while i < len(prog):
        c = prog[i]
        if c in 'WB':
            label = None
            nxt = prog[i + 1] if i + 1 < len(prog) else ''
            if nxt.isalpha() and nxt.islower():
                label = nxt
                i += 1
            if prev_dir is None:            # start tick + direction arrow
                tick_at(x - dx * END_SHIFT, y - dy * END_SHIFT, dx, dy)
                for (ax1, ay1), (ax2, ay2) in ARROW:
                    ticks.append((
                        (x + dx * ax1 - dy * ay1, y + dy * ax1 + dx * ay1),
                        (x + dx * ax2 - dy * ay2, y + dy * ax2 + dx * ay2),
                    ))
            elif prev_dir == (dx, dy):      # junction tick, centered
                tick_at(x, y, dx, dy)
            glyph(c == 'B', label)
            prev_dir = (dx, dy)
        elif c == '+':
            right()
        elif c == '-':
            left()
        i += 1

    if prev_dir is not None:            # end tick, flush with the cap
        pdx, pdy = prev_dir
        tick_at(x + pdx * END_SHIFT, y + pdy * END_SHIFT, pdx, pdy)

    # bounding box over everything drawn
    pts = list(path)
    for a, b in diagonals + ticks:
        pts += [a, b]
    pts += [(lx, ly) for lx, ly, _ in labels]
    minx = floor(min(p[0] for p in pts))
    maxx = ceil(max(p[0] for p in pts))
    miny = floor(min(p[1] for p in pts))
    maxy = ceil(max(p[1] for p in pts))
    gw = maxx - minx                                    # graphics width
    cap_w = int(0.6 * CAPTION_SIZE * len(caption))      # est. monospace width
    cap_h = CAPTION_SIZE + CAPTION_GAP if caption else 0
    w = max(gw, cap_w) + 2 * MARGIN
    h = maxy - miny + 2 * MARGIN + cap_h
    ox = MARGIN + max(0, cap_w - gw) // 2 - minx
    oy = MARGIN + cap_h - miny

    d = "M " + " L ".join(f"{px + ox} {py + oy}" for px, py in path)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {w} {h}" width="{w}" height="{h}">',
        f'  <path d="{d}" fill="none" stroke="black" '
        f'stroke-width="{STROKE}" stroke-linecap="square" stroke-linejoin="miter"/>',
    ]
    for (x1, y1), (x2, y2) in diagonals:
        out.append(
            f'  <line x1="{x1 + ox}" y1="{y1 + oy}" x2="{x2 + ox}" y2="{y2 + oy}" '
            f'stroke="black" stroke-width="{STROKE}" stroke-linecap="square"/>'
        )
    for (x1, y1), (x2, y2) in ticks:
        out.append(
            f'  <line x1="{x1 + ox:g}" y1="{y1 + oy:g}" x2="{x2 + ox:g}" y2="{y2 + oy:g}" '
            f'stroke="black" stroke-width="{STROKE / 2:g}" stroke-linecap="square"/>'
        )
    for lx, ly, ch in labels:
        out.append(
            f'  <text x="{lx + ox}" y="{ly + oy}" font-size="{LABEL_SIZE}" '
            f'font-family="monospace" text-anchor="middle" '
            f'dominant-baseline="middle">{ch}</text>'
        )
    if caption:
        out.append(
            f'  <text x="{w / 2:g}" y="{MARGIN + CAPTION_SIZE / 2:g}" '
            f'font-size="{CAPTION_SIZE}" font-family="monospace" '
            f'text-anchor="middle" dominant-baseline="middle">'
            f'{escape(caption)}</text>'
        )
    out.append('</svg>')
    print("\n".join(out))


if __name__ == "__main__":
    main()
