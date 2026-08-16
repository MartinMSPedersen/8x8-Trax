#!/bin/bash
# certbisect.sh - find which rust build introduced a wasmcheck NODES drift,
# by re-running the REAL cert against each build's wasm.
#
#   bash tools/certbisect.sh <first-ordinal> <last-ordinal>     # e.g. 321 334
#
# For each build in range: check out that build's src/ (per-pack commits),
# `make wasm` (a few seconds each), run the exact cert pipeline the Makefile
# runs, and print the first NODES line (or "certified"). Requires the same
# book/threat/eval.conf the failing cert used - they are already in the tree.
# The first build whose result differs from its predecessor is the culprit.
set -u
FROM=${1:?first ordinal}; TO=${2:?last ordinal}
here=$(pwd)
work=$(mktemp -d)
echo "# bisecting rust$FROM..rust$TO against the live cert (wasm, real harness)"
for n in $(seq "$FROM" "$TO"); do
  sha=$(git log --all --format='%H %s' 2>/dev/null | grep -m1 "rust$n-" | cut -d' ' -f1)
  if [ -z "$sha" ]; then echo "rust$n: no commit found (skipped)"; continue; fi
  d="$work/rust$n"; mkdir -p "$d"
  git archive "$sha" src Cargo.toml Makefile tools web 2>/dev/null | tar -x -C "$d" || { echo "rust$n: archive failed"; continue; }
  cp -r "$here/book" "$here/threat" "$d/" 2>/dev/null; cp "$here/eval.conf" "$d/" 2>/dev/null || true
  ( cd "$d" && make wasm >/dev/null 2>&1 || { echo "rust$n: wasm build failed"; exit 0; }
    out=$(node tools/search_transcript.js 8 1 3 --book 2>/dev/null | node tools/wasmcheck.js web/trax.wasm 3 2>&1)
    line=$(echo "$out" | grep -m1 -E "NODES mismatch|VALUE mismatch|MOVE mismatch")
    if [ -n "$line" ]; then echo "rust$n: $line"; else echo "rust$n: certified"; fi )
done
rm -rf "$work"
echo "# the first build whose line differs from the one before it is the culprit"
