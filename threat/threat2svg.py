#!/usr/bin/env python3
"""Read a W/B/+/- string from stdin, write SVG to stdout.

Usage: echo 'WaB+WaB+B-WbWcW+WW+WWcBWb 5 1 2 0 1 2,0/' | ./threat2svg.py > out.svg
"""
import sys
import html
from math import ceil, floor

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


class ThreatRenderer:
    def __init__(self):
        self.x, self.y = 0, 0
        self.dx, self.dy = 1, 0      # heading right
        self.path = [(self.x, self.y)]  # one continuous polyline
        self.diagonals = []          # extra segments from B
        self.labels = []             # (x, y, char) from lowercase suffixes
        self.ticks = []              # junction marks between same-direction glyphs
        self.prev_dir = None         # heading at the end of the previous glyph

    def forward(self, n):
        self.x += self.dx * n
        self.y += self.dy * n
        self.path.append((self.x, self.y))

    def right(self):
        self.dx, self.dy = -self.dy, self.dx

    def left(self):
        self.dx, self.dy = self.dy, -self.dx

    def tick_at(self, cx, cy, tdx, tdy):
        self.ticks.append(((cx + tdy * TICK, cy - tdx * TICK),
                           (cx - tdy * TICK, cy + tdx * TICK)))

    def glyph(self, cross, label=None):
        if label is not None:
            # local (LABEL_X, LABEL_Y): x-axis = heading, y-axis = 90 deg right
            lx = self.x + self.dx * LABEL_X - self.dy * LABEL_Y
            ly = self.y + self.dy * LABEL_X + self.dx * LABEL_Y
            self.labels.append((lx, ly, label))
            
        pts = []
        self.forward(LONG);  pts.append((self.x, self.y))    # local (12,0)
        self.right()
        self.forward(SHORT); pts.append((self.x, self.y))    # local (12,6)
        self.left()
        self.forward(SHORT); pts.append((self.x, self.y))    # local (18,6)
        self.left()
        self.forward(SHORT); pts.append((self.x, self.y))    # local (18,0)
        self.right()
        self.forward(LONG)                                   # local (30,0)
        
        if cross:
            self.diagonals.append((pts[0], pts[2]))   # (12,0)-(18,6)
            self.diagonals.append((pts[1], pts[3]))   # (12,6)-(18,0)

    def parse(self, prog):
        i = 0
        while i < len(prog):
            c = prog[i]
            if c in 'WB':
                label = None
                nxt = prog[i + 1] if i + 1 < len(prog) else ''
                if nxt.isalpha() and nxt.islower():
                    label = nxt
                    i += 1
                    
                if self.prev_dir is None:            # start tick + direction arrow
                    self.tick_at(self.x - self.dx * END_SHIFT, self.y - self.dy * END_SHIFT, self.dx, self.dy)
                    for (ax1, ay1), (ax2, ay2) in ARROW:
                        self.ticks.append((
                            (self.x + self.dx * ax1 - self.dy * ay1, self.y + self.dy * ax1 + self.dx * ay1),
                            (self.x + self.dx * ax2 - self.dy * ay2, self.y + self.dy * ax2 + self.dx * ay2),
                        ))
                elif self.prev_dir == (self.dx, self.dy):  # junction tick, centered
                    self.tick_at(self.x, self.y, self.dx, self.dy)
                    
                self.glyph(c == 'B', label)
                self.prev_dir = (self.dx, self.dy)
            elif c == '+':
                self.right()
            elif c == '-':
                self.left()
            i += 1

        if self.prev_dir is not None:            # end tick, flush with the cap
            pdx, pdy = self.prev_dir
            self.tick_at(self.x + pdx * END_SHIFT, self.y + pdy * END_SHIFT, pdx, pdy)

    def generate_svg(self, caption):
        # bounding box over everything drawn
        pts = list(self.path)
        for a, b in self.diagonals + self.ticks:
            pts += [a, b]
        pts += [(lx, ly) for lx, ly, _ in self.labels]
        
        if not pts:
            return "<svg></svg>"

        # Extract axes once for efficiency
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        minx, maxx = floor(min(xs)), ceil(max(xs))
        miny, maxy = floor(min(ys)), ceil(max(ys))
        
        gw = maxx - minx                                    # graphics width
        cap_w = int(0.6 * CAPTION_SIZE * len(caption))      # est. monospace width
        cap_h = CAPTION_SIZE + CAPTION_GAP if caption else 0
        w = max(gw, cap_w) + 2 * MARGIN
        h = maxy - miny + 2 * MARGIN + cap_h
        ox = MARGIN + max(0, cap_w - gw) // 2 - minx
        oy = MARGIN + cap_h - miny

        d = "M " + " L ".join(f"{px + ox:g} {py + oy:g}" for px, py in self.path)
        out = [
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">',
            f'  <path d="{d}" fill="none" stroke="black" '
            f'stroke-width="{STROKE:g}" stroke-linecap="square" stroke-linejoin="miter"/>',
        ]
        
        for (x1, y1), (x2, y2) in self.diagonals:
            out.append(
                f'  <line x1="{x1 + ox:g}" y1="{y1 + oy:g}" x2="{x2 + ox:g}" y2="{y2 + oy:g}" '
                f'stroke="black" stroke-width="{STROKE:g}" stroke-linecap="square"/>'
            )
        for (x1, y1), (x2, y2) in self.ticks:
            out.append(
                f'  <line x1="{x1 + ox:g}" y1="{y1 + oy:g}" x2="{x2 + ox:g}" y2="{y2 + oy:g}" '
                f'stroke="black" stroke-width="{STROKE / 2:g}" stroke-linecap="square"/>'
            )
        for lx, ly, ch in self.labels:
            out.append(
                f'  <text x="{lx + ox:g}" y="{ly + oy:g}" font-size="{LABEL_SIZE:g}" '
                f'font-family="monospace" text-anchor="middle" '
                f'dominant-baseline="middle">{ch}</text>'
            )
        if caption:
            out.append(
                f'  <text x="{w / 2:g}" y="{MARGIN + CAPTION_SIZE / 2:g}" '
                f'font-size="{CAPTION_SIZE:g}" font-family="monospace" '
                f'text-anchor="middle" dominant-baseline="middle">'
                f'{html.escape(caption)}</text>'
            )
        out.append('</svg>')
        return "\n".join(out)


def main():
    data = sys.stdin.read()
    parts = data.split(maxsplit=1)
    prog = parts[0] if parts else ''
    caption = parts[1].strip() if len(parts) > 1 else ''

    renderer = ThreatRenderer()
    renderer.parse(prog)
    #print(renderer.generate_svg(caption))
    print(renderer.generate_svg(data))


if __name__ == "__main__":
    main()
