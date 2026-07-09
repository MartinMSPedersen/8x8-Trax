# White threats. Black threats are auto-derived by swapping W<->B.
#
# Boundary notation: walk the occupied region clockwise (occupied on the right);
# W/B = edge colour (UPPERCASE), + = right turn, - = left turn, nothing = straight.
#
# Line format:  PATTERN  win  spN spE spS spW  <activating moves...>
#   win      = plies in the shortest forced win        (lower = more urgent)
#   spN..spW = empty cells needed to the N,E,S,W        (threat is gated out if a
#              direction lacks room). Given in the threat reference orientation:
#              imagine its FIRST edge walked East; N/E/S/W are then map directions.
#              The matcher rotates them to the board per occurrence.
#   moves    = one or more moves that ACTIVATE the threat, each "dcol,drow geom":
#              a tile (geom = + / \) placed at an offset from the anchor cell, in
#              the same reference orientation (first edge East). Rotated+translated
#              to each occurrence (a quarter-turn swaps / and \). e.g. 0,-1/ 1,0\
#   numbers fill win,spN,spE,spS,spW in order (missing default to 0); the rest of the
#   tokens are activating moves. Both are optional.
#
# Length specifier on an edge: {n} exactly n, {n,m} n..m, {n,} n-or-more.
#   e.g. B{1,2} matches a 1- or 2-long straight B wall, so this one line replaces
#   the separate W+WB-W+W and W+WBB-W+W patterns.
#
# Path tag: a lowercase letter after a colour (e.g. Wa) labels a line-end. Two edges
#   sharing a tag must be the two ends of ONE track, so a tagged threat matches only
#   when those ends are actually connected. Example (both white ends are one path):
#       W-W+B-BWa-BWa
#
# Tip: in the UI, the "threats" command prints each match with its anchor cell,
# heading, free space (freeNESW), verified tag pairings, and its activating moves
# resolved to the board (cell+geom; trailing * = target cell already occupied), so
# you can calibrate all of these.
#
# Split patterns across as many files in this directory as you like.
