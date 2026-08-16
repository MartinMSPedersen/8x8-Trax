// Trax web UI. All game logic and validation live in the wasm engine (worker.js);
// this file renders state, translates clicks/typing into protocol lines, and
// drives the engine per the selected mode. Tiles are SVG (tiles/svg/<kind>.svg,
// win-path variants under tiles/svg/win/<white|black>/) - one vector set, every
// size crisp; the classic GIF skin's measured palette and geometry live on in
// tools/gen_tiles_svg.py, which regenerates the set.

'use strict';

const $ = (id) => document.getElementById(id);
const SIZES = { tiny: 15, small: 25, medium: 50, large: 75 };
// Tiny exists for the loop variant, whose unbounded boards can sprawl far
// beyond what 25px columns can show. SVG tiles make every size native-crisp.

// Warm the tile cache: embedded-webview asset servers can drop some of the
// dozens of simultaneous <img> requests a board render fires, leaving broken
// tiles. Preloading the current size's 18 tiles once (sequentially, at idle)
// makes every later render a memory-cache hit - immune to render churn.
const KINDS = ['es', 'nw', 'ns', 'ew', 'sw', 'en'];
function warmTiles() {
  if (typeof Image === 'undefined') return;
  const urls = [];
  for (const k of KINDS) {
    urls.push(tileUrl(k, null), tileUrl(k, 'white'), tileUrl(k, 'black'));
  }
  let i = 0;
  (function next() {
    if (i >= urls.length) return;
    const im = new Image();
    im.onload = im.onerror = () => setTimeout(next, 10);
    im.src = urls[i++];
  })();
}

// A tile that lost its load race retries once instead of staying broken.
function tileImg(img) {
  img.onerror = () => {
    img.onerror = null;
    const src = img.src;
    setTimeout(() => { img.src = src.split('#')[0] + '#r'; }, 150);
  };
  return img;
}

let worker = null;
let nextId = 1;
const pending = new Map();
let state = null;          // last state JSON from the engine
let preview = null;        // {notation, placed:[{c,r,t,forced}]} or null
let previewCell = null;    // {c,r,idx} click-cycling anchor
let thinking = false;
let queuedKnowledge = null;

function send(line) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ id, line });
  });
}

function spawnWorker() {
  if (worker) worker.terminate();
  pending.clear();
  thinking = false;
  const cb = typeof window !== 'undefined' && window.CACHEBUST; // uicheck runs headless
  worker = new Worker('worker.js' + (cb ? '?v=' + cb : ''));
  // Post the page's variant IMMEDIATELY: the worker queues pre-boot messages and
  // replays them in order, so this is guaranteed to reach the fresh session before
  // any other command (a fast New Game click, a queued move) can touch it. Kills
  // the whole class of "respawned session briefly runs default rules" races.
  const v0 = $('variant') && $('variant').value;
  if (v0 && v0 !== '8x8') send('VARIANT ' + v0);
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.fatal) { $('status').textContent = 'Engine failed to load: ' + d.fatal; return; }
    if (d.ready) {
      engineBuild = d.build || engineBuild;
      queuedKnowledge = knowledgeLine(d);
      $('knowledge').textContent = queuedKnowledge;
      // Device-sized TT: the worker chose a cap for this machine; say so once
      // in the engine pane so a phone player understands the smaller table.
      if (d.ttCap && $('optoutput') && $('optoutput').checked)
        logEngine('# tt: cap ' + (d.ttCap / 1e6) + 'M entries (~' + Math.round(d.ttCap * 98 / 1e6) + ' MB) - ' + d.ttTier);
      // The ready counts describe the boot (8x8) session; if the page is on a
      // different variant, ask the post-switch session for ITS counts.
      if ($('variant').value !== '8x8') refreshKnowledge();
      // A fresh worker session starts at the default variant; re-assert the page's
      // selection so respawns (New Game during a think, mode changes) keep the rules.
      const v = $('variant').value;
      (v !== '8x8' ? send('VARIANT ' + v) : send('STATE')).then(onState).then(maybeEngine);
      return;
    }
    if (d.depth !== undefined) {
      // One gate for the whole pane: the raw depth/noise/book relay used to
      // be unconditional while headers and 'played' checked the box - an
      // unchecked box produced framing-free ghost streams (field case).
      if ($('optoutput').checked) logEngine(d.depth);
      return;
    }
    const r = pending.get(d.id);
    if (r) {
      pending.delete(d.id);
      let v;
      try { v = JSON.parse(d.resp); } catch (_) { v = d.resp; } // SAVE replies raw
      r(v);
    }
  };
}

// ---------- rendering -------------------------------------------------------

// The eighth liar: tiles were the only asset without the ?v= build stamp,
// so through the whole 297-305 art arc the CDN and browser could serve any
// stale mix of tile generations - three operator verdicts may have judged
// art that was not deployed. Stamped like everything else now; what the eye
// sees is finally what the build ships.
const TILE_Q = (typeof window !== 'undefined' && window.CACHEBUST) ? ('?v=' + window.CACHEBUST) : '';
function tileUrl(kind, winner) {
  const base = 'tiles/svg/';
  return (winner ? `${base}win/${winner}/${kind}.svg` : `${base}${kind}.svg`) + TILE_Q;
}

function render() {
  const board = $('board');
  board.innerHTML = '';
  if (!state) return;
  const size = $('tilesize').value;
  const px = SIZES[size];
  if (!warmTiles.done) { warmTiles.done = true; warmTiles(); }
  const showForced = $('optforced').checked;

  // Grid = bounding box plus one placement ring - but only on axes that can still
  // grow: at 8 tiles wide no move can exist left or right of the board, so showing
  // ring columns there would suggest placements the rules forbid. Same for rows.
  const vs = viewData || state; // the board being DRAWN (history view or live)
  const viewing = viewData !== null;
  const bb = vs.bbox || { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 };
  const cap = state.variant && state.variant.startsWith('12x12') ? 12 : 8;
  const colPad = vs.bbox && (bb.maxCol - bb.minCol + 1) < cap ? 1 : 0;
  const rowPad = vs.bbox && (bb.maxRow - bb.minRow + 1) < cap ? 1 : 0;
  const c0 = bb.minCol - colPad, c1 = bb.maxCol + colPad;
  const r0 = bb.minRow - rowPad, r1 = bb.maxRow + rowPad;
  const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
  // Fit-to-column: the chosen tile size is a CEILING, not a promise. The board
  // measures the space its column actually has and shrinks tiles to fit, so a
  // 12x12 board at "large" can never overlap the controls - it scales down
  // instead (floor 24px; below that the CSS overflow scroll takes over).
  const wrap = document.getElementById('boardwrap');
  const avail = wrap && wrap.clientWidth ? wrap.clientWidth - 6 : 0; // board padding+border
  // The shrink floor must never INFLATE a deliberately tiny request: floor
  // is min(24, chosen) so tiny=15 renders at 15, while medium+ still refuse
  // to collapse below 24 before scroll takes over.
  const pxEff = avail > 0 ? Math.max(Math.min(24, px), Math.min(px, Math.floor(avail / cols))) : px;
  board.style.gridTemplateColumns = `repeat(${cols}, ${pxEff}px)`;
  board.style.gridTemplateRows = `repeat(${rows}, ${pxEff}px)`;

  const tiles = new Map(vs.tiles.map((t) => [`${t.c},${t.r}`, t.t]));
  const winCells = new Set(((viewing ? null : state.winCells) || []).map((w) => `${w.c},${w.r}`));
  const winner = state.result === 'white' ? 'white' : state.result === 'black' ? 'black' : null;
  const legalByCell = new Map();
  for (const m of (viewing ? [] : state.legal || [])) {
    const k = `${m.c},${m.r}`;
    if (!legalByCell.has(k)) legalByCell.set(k, []);
    legalByCell.get(k).push(m);
  }
  const prevByCell = new Map((preview ? preview.placed : []).map((p) => [`${p.c},${p.r}`, p]));

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const key = `${c},${r}`;
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.width = pxEff + 'px';
      cell.style.height = pxEff + 'px';
      const placedKind = tiles.get(key);
      const prev = prevByCell.get(key);
      // "Show forced moves" OFF hides the cascade consequences entirely: the
      // cell renders empty (not even a playable marker - the square is spoken
      // for) until Commit reveals them. Previously the checkbox only swapped
      // class names the stylesheet rendered identically - a placebo.
      const hideForced = prev && prev.forced && !showForced;
      if (prev && !placedKind && !hideForced) {
        // preview tile: the chosen one plain-preview, cascade tiles glowing
        const img = document.createElement('img');
        tileImg(img).src = tileUrl(prev.t, null);
        img.className = prev.forced && showForced ? 'tile forced' : 'tile preview';
        img.draggable = false;
        cell.appendChild(img);
        // Clicking the previewed (uncommitted) anchor cycles candidate
        // geometries at that cell. Clicking a FORCED preview tile re-anchors
        // the staging there instead - the old selection dissolves and that
        // cell becomes the new choice point - provided the cell is a legal
        // direct placement on the real board (second-order cascade cells,
        // reachable only through other preview tiles, stay inert: you
        // genuinely cannot stage there). cycleCell handles both roles:
        // same cell cycles, new cell stages fresh.
        if (humanToMove() && !thinking && (!prev.forced || legalByCell.has(key))) {
          cell.classList.add('playable');
          cell.addEventListener('click', () => cycleCell(c, r));
        }
      } else if (placedKind) {
        const img = document.createElement('img');
        const asWin = winner && winCells.has(key) ? winner : null;
        tileImg(img).src = tileUrl(placedKind, asWin);
        img.className = 'tile';
        img.draggable = false;
        // a committed tile being re-covered by a forced cascade in the preview
        if (prev && prev.forced && showForced) {
          const ov = document.createElement('img');
          ov.src = tileUrl(prev.t, null);
          ov.className = 'tile forced overlay';
          ov.draggable = false;
          cell.appendChild(img);
          cell.appendChild(ov);
        } else {
          cell.appendChild(img);
        }
      } else if (!hideForced && legalByCell.has(key) && !state.over && !thinking && humanToMove()) {
        cell.classList.add('playable');
        cell.title = legalByCell.get(key).map((m) => m.n).join('  ');
        cell.addEventListener('click', () => cycleCell(c, r));
      }
      board.appendChild(cell);
    }
  }
  // Moves panel mirrors the history view: while browsing, moves beyond the
  // viewed ply dim to "the future" and the viewed move is emphasised. Every
  // move is clickable and jumps the view there (clicking the last returns to
  // live) - the list doubles as a scrubber. Display only, like the arrows.
  // Lives in render(), NOT onState: browsing repaints through render while the
  // engine thinks, and the greys must follow the view, not the engine's clock.
  {
    const hd = $('history');
    const mvs = state.moves || [];
    hd.innerHTML = '';
    if (!mvs.length) hd.textContent = '(no moves yet)';
    else {
      const k = viewPly === null ? mvs.length : viewPly;
      mvs.forEach((m, i) => {
        if (i) hd.appendChild(document.createTextNode(' ')); // separator OUTSIDE the span: hover underline covers the move only
        const sp = document.createElement('span');
        sp.textContent = m;
        sp.className = 'mv' + (i >= k ? ' future' : '') + (viewPly !== null && i === k - 1 ? ' cur' : '');
        sp.addEventListener('click', () => setView(i + 1));
        hd.appendChild(sp);
      });
    }
  }
  // History-nav widgets (absent in the headless harness).
  const hb = $('histback'), hf = $('histfwd'), hp = $('histpos');
  const h1 = $('histfirst'), hl = $('histlast');
  if (hb && hf && hp) {
    const total = (state.moves || []).length;
    hb.disabled = total === 0 || viewPly === 1;
    hf.disabled = viewPly === null;
    if (h1) h1.disabled = total === 0 || viewPly === 1;
    if (hl) hl.disabled = viewPly === null;
    hp.textContent = viewPly === null
      ? (total ? ` ${total}/${total} ` : '')
      : ` ${viewPly}/${total} `;
  }
  schedulePonder();
}

// (schedulePonder is called from onState below)
function humanToMove() {
  if (!state || state.over) return false;
  const machines = machineSides();
  return !machines.has(state.toMove);
}

function machineSides() {
  const v = document.querySelector('input[name=mode]:checked').value;
  return new Set(v === 'mb' ? ['B'] : v === 'mw' ? ['W'] : v === 'mm' ? ['W', 'B'] : []);
}

function statusLine() {
  if (!state) return '';
  if (state.over) {
    if (state.result === 'draw') return `Game over: draw (${state.reason}).`;
    const w = state.result === 'white' ? 'White' : 'Black';
    return `Game over: ${w} wins (${state.reason}).`;
  }
  const side = state.toMove === 'W' ? 'White' : 'Black';
  const who = machineSides().has(state.toMove) ? 'engine' : 'you';
  return thinking
    ? `Move ${state.moveCount + 1} - ${side} (engine) is thinking\u2026`
    : `Move ${state.moveCount + 1} - ${side} to move (${who}).`;
}

// Per-ply board snapshots, captured from every live STATE the page sees, so
// history browsing is a pure memory lookup - it works even while the engine
// (single-threaded wasm) is deep in a search and could not answer HIST.
// HIST remains the fallback for plies this page never witnessed (after Load).
let snapshots = {};
let autoStagedGame = false;
function onState(r) {
  if (r && typeof r.moveCount === 'number' && r.moveCount > 0) autoStagedGame = false; // re-arm for the next fresh board
  if (r && r.ok && Array.isArray(r.tiles) && Array.isArray(r.moves)) {
    snapshots[r.moves.length] = {
      tiles: r.tiles, bbox: r.bbox,
      last: r.moves.length ? r.moves[r.moves.length - 1] : null,
    };
  }
  if (r && r.variant) {
    if ($('variant').value !== r.variant) $('variant').value = r.variant;
    const tag = r.variant.endsWith('-draw') ? ` \u00b7 ${r.variant} draw` : ` \u00b7 ${r.variant}`;
    if (queuedKnowledge) $('knowledge').textContent = queuedKnowledge + tag;
  }
  if (!r.ok) { showErr(r.error); return r; }
  state = r;
  preview = null;
  previewCell = null;
  $('movebox').value = '';
  $('commitbtn').disabled = true;
  showErr('');
  if (r.engine && r.engine.lines && $('optoutput').checked) {
    logEngine(`played ${r.engine.move}  (${(r.engine.ms / 1000).toFixed(1)}s, ${r.engine.nodes} nodes, book hits ${r.engine.bookHits})`);
    // Forensic tripwire: a timed think returning ZERO nodes is the anomaly
    // under investigation - auto-fetch the search's internal counters so the
    // incident documents itself in the engine pane. Silent on healthy thinks.
    if (r.engine.nodes === 0 && r.engine.ms > 1000) {
      send('LASTSTATS').then((t) => logEngine('# forensics (zero-node think): ' + t)).catch(() => {});
    }
  }
  $('status').textContent = statusLine();
  render();
  maybeAutoStage(); // fresh empty board + human to move => pre-stage the curve
  return r;
}

function showErr(msg) { $('moveerr').textContent = msg || ''; }

let engineBuild = '';
function knowledgeLine(d) {
  return `${d.threats} threat patterns, ${d.book} book positions`
    + (d.replies ? `, ${d.replies} replies` : '')
    + (engineBuild ? ` \u00b7 engine ${engineBuild}` : '');
}
// Refresh the footer from the ACTIVE session - counts are per variant (each
// ruleset loads its own reply file), so a cached boot-time line goes stale
// the moment the variant changes.
async function refreshKnowledge() {
  try {
    // send() already resolves with the parsed response object (the message
    // handler JSON.parses it); parsing again threw and silently no-opped the
    // whole refresh - the footer showed boot (8x8) counts under a draw tag.
    const d = await send('KNOWLEDGE');
    if (d && d.ok) {
      queuedKnowledge = knowledgeLine(d);
      const v0 = $('variant').value;
      const tag = v0.endsWith('-draw') ? ` \u00b7 ${v0} draw` : ` \u00b7 ${v0}`;
      $('knowledge').textContent = queuedKnowledge + tag;
    }
  } catch { /* footer keeps its last line */ }
}

function logEngine(line) {
  const pre = $('enginelog');
  pre.textContent += line + '\n';
  pre.scrollTop = pre.scrollHeight;
}

// ---------- input: click-to-cycle ------------------------------------------

async function cycleCell(c, r) {
  if (viewPly !== null) { showErr('viewing history - press \u25b6 to return to the live game'); return; }
  if (!humanToMove() || thinking) return;
  const options = (state.legal || []).filter((m) => m.c === c && m.r === r);
  if (!options.length) return;
  let idx = 0;
  if (previewCell && previewCell.c === c && previewCell.r === r) {
    idx = (previewCell.idx + 1) % options.length;
  } else if (preview && preview.placed.length && preview.placed[0].c === c && preview.placed[0].r === r) {
    // a typed preview sits here: continue the cycle from its geometry
    const cur = options.findIndex((m) => m.n === preview.notation);
    idx = ((cur >= 0 ? cur : -1) + 1) % options.length;
  }
  previewCell = { c, r, idx };
  const m = options[idx];
  const p = await send(`PREVIEWC ${c} ${r} ${m.g}`);
  if (!p.ok) { showErr(p.error); return; }
  preview = p;
  $('movebox').value = p.notation;
  $('commitbtn').disabled = false;
  showErr('');
  render();
}

// A fresh, empty board with a human to move pre-stages the curve at the
// origin - an uncommitted tile that says "this is how moves work" without a
// word of instructions (sister-tested onboarding). Fires once per game: the
// flag re-arms when a game progresses, so clicking away to deselect is
// respected rather than fought.
async function maybeAutoStage() {
  if (autoStagedGame || !state) return;
  if (state.moveCount !== 0 || state.over || viewPly !== null) return;
  if (!humanToMove() || thinking || preview) return;
  const options = (state.legal || []).filter((m) => m.c === 0 && m.r === 0);
  if (!options.length) return;
  autoStagedGame = true;
  let idx = options.findIndex((m) => m.g === '/');   // prefer the curve
  if (idx < 0) idx = 0;
  previewCell = { c: 0, r: 0, idx };
  const p = await send(`PREVIEWC 0 0 ${options[idx].g}`);
  if (!p.ok) { previewCell = null; return; }
  preview = p;
  $('movebox').value = p.notation;
  $('commitbtn').disabled = false;
  render();
}

// ---------- input: typed move -----------------------------------------------

async function previewTyped() {
  const tok = $('movebox').value.trim();
  if (!tok) { preview = null; previewCell = null; $('commitbtn').disabled = true; render(); return; }
  // A pasted SEQUENCE of moves: no single-move preview to show - stay quiet,
  // enable Commit, and let commit() play the tokens one by one.
  if (/\s/.test(tok)) {
    preview = null; previewCell = null;
    $('commitbtn').disabled = false;
    showErr('');
    render();
    return;
  }
  const p = await send('PREVIEW ' + tok);
  if (!p.ok) { preview = null; $('commitbtn').disabled = true; showErr(p.error); render(); return; }
  preview = p;
  previewCell = null;
  $('commitbtn').disabled = false;
  showErr('');
  render();
}

async function commit() {
  if (viewPly !== null) { showErr('viewing history - press \u25b6 to return to the live game'); return; }
  if (thinking || !humanToMove()) return;
  // Multi-move entry: a whitespace-separated list in the move box (a pasted
  // game, a line to replay) plays token by token. On a bad token it stops
  // with the token's number and name; the good prefix stays on the board.
  const toks = $('movebox').value.trim().split(/\s+/).filter(Boolean);
  if (toks.length > 1) {
    for (let i = 0; i < toks.length; i++) {
      if (state && state.over) { showErr(`game over after move ${i} - '${toks[i]}' and the rest not played`); break; }
      const r = await send('PLAY ' + toks[i]);
      if (!r.ok) { showErr(`move ${i + 1} ('${toks[i]}'): ${r.error}`); break; }
      onState(r);
    }
    $('movebox').value = '';
    preview = null; previewCell = null;
    $('commitbtn').disabled = true;
    render();
    maybeEngine();
    return;
  }
  if (!preview) return;
  const r = await send('PLAY ' + preview.notation);
  if (!r.ok) { showErr(r.error); return; }
  onState(r);
  maybeEngine();
}

// ---------- engine driving ---------------------------------------------------

async function maybeEngine() {
  if (!state || thinking) return;
  if (state.over) {
    // switching to a machine mode on a finished game: say why nothing happens
    if (machineSides().size && $('optoutput').checked) logEngine('(game is over - press New game to let the engines play)');
    return;
  }
  if (!machineSides().has(state.toMove)) return;
  // Structural invariant: no human staging survives an engine think - belt
  // for any future path that reaches here with a preview still on the board.
  if (preview || previewCell) { preview = null; previewCell = null; $('commitbtn').disabled = true; }
  thinking = true;
  $('status').textContent = statusLine();
  render();
  const time = $('strength').value;
  const noise = $('optvary').checked ? 10 : 0;
  const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  if ($('optoutput').checked) logEngine(`-- ${state.toMove === 'W' ? 'White' : 'Black'} thinking (${Number(time) / 1000}s) --`);
  const r = await send(`ENGINE ${time} 0 ${noise} ${seed}`);
  thinking = false;
  onState(r);
  if (!state.over && machineSides().has(state.toMove)) {
    setTimeout(maybeEngine, 150); // Two Machines: breathe between moves
  }
}

// ---------- buttons ----------------------------------------------------------

async function newGame() {
  viewPly = null; viewData = null; snapshots = {};
  if (thinking) { spawnWorker(); $('enginelog').textContent = ''; return; } // cancels the think, re-inits
  const r = await send('NEW');
  $('enginelog').textContent = '';
  onState(r);
  maybeEngine();
}

async function saveGame() {
  const r = await send('SAVE');
  if (typeof r === 'object') { showErr(r && r.error || 'save failed'); return; }
  const raw = String(r);
  const text = raw.startsWith('SAVE|') ? raw.slice(5).replace(/~/g, '\n') : raw;
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trax-game.trx';
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadGame() { viewPly = null; viewData = null; snapshots = {}; $('loadfile').click(); }

async function loadFile(ev) {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const text = await f.text();
  const r = await send('LOAD ' + text.replace(/\r?\n/g, '~'));
  if (!r.ok) { showErr(r.error); return; }
  onState(r);
  maybeEngine();
}

// ---------- wiring -----------------------------------------------------------


// ---- Save GIF: the whole game as an animated gif, one frame per ply ----
// Frames ride the same HIST/snapshots machinery as the history viewer, so the
// export shows exactly what the viewer shows; the final frame is the live end
// state with the win path highlighted. Encoding is a self-contained GIF89a
// writer (16-colour global palette - the board is flat-colour by construction,
// so nearest-mapping antialiased edges to the measured palette is invisible at
// gif scale). 0.5 s per frame (delay 50 cs), 2 s hold on the last. No
// libraries: every build stays self-contained.
const GIF_PAL = [0x202020, 0xE22000, 0xFFFFFF, 0x000000, 0xFFFF40, 0x0000C0, 0xFF4040, 0x800000];
function gifNearest(r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < GIF_PAL.length; i++) {
    const p = GIF_PAL[i], dr = r - (p >> 16), dg = g - ((p >> 8) & 255), db = b - (p & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function gifLzw(indices, minCode) {
  const out = []; let cur = 0, bits = 0;
  const emit = (code, size) => { cur |= code << bits; bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; } };
  const CLEAR = 1 << minCode, EOI = CLEAR + 1;
  let size = minCode + 1, next = EOI + 1, dict = new Map();
  emit(CLEAR, size);
  let prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = (prev << 12) | indices[i];
    if (dict.has(k)) { prev = dict.get(k); continue; }
    emit(prev, size);
    if (next < 4096) { dict.set(k, next++); if (next - 1 === 1 << size && size < 12) size++; }
    else { emit(CLEAR, size); size = minCode + 1; next = EOI + 1; dict = new Map(); }
    prev = indices[i];
  }
  emit(prev, size); emit(EOI, size);
  if (bits > 0) out.push(cur & 255);
  return out;
}
function gifSubBlocks(bytes, out) {
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n); for (let j = 0; j < n; j++) out.push(bytes[i + j]);
  }
  out.push(0);
}
function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}
async function saveGif() {
  const total = state ? (state.moves || []).length : 0;
  if (!total) { showErr('no game to export'); return; }
  const btn = $('savegif'); btn.disabled = true;
  try {
    // Gather every frame's data first (snapshots cache serves repeats).
    const frames = [];
    for (let k = 1; k < total; k++) {
      let d = snapshots[k];
      if (!d) {
        const r = await send('HIST ' + k);
        if (!(r && r.ok)) throw new Error('HIST ' + k + ' failed');
        d = snapshots[k] = { tiles: r.tiles, bbox: r.bbox, last: r.last };
      }
      frames.push({ tiles: d.tiles, bbox: d.bbox, win: null });
    }
    const wn = state.result === 'white' || state.result === 'black' ? state.result : null;
    const wc = new Set((state.winCells || []).map((w) => `${w.c},${w.r}`));
    frames.push({ tiles: state.tiles, bbox: state.bbox, win: wn ? { winner: wn, cells: wc } : null });
    // Union bbox: one stable canvas, no jumping as the board grows.
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const f of frames) { c0 = Math.min(c0, f.bbox.minCol); c1 = Math.max(c1, f.bbox.maxCol);
                              r0 = Math.min(r0, f.bbox.minRow); r1 = Math.max(r1, f.bbox.maxRow); }
    const px = 60, W = (c1 - c0 + 1) * px, H = (r1 - r0 + 1) * px;
    const imgs = new Map();
    // Sharpness: an SVG with only a viewBox has a browser-default intrinsic
    // size, and drawImage then scales that bitmap - blur. Injecting explicit
    // width/height makes the browser rasterize the vector at exactly px.
    const loadImgSized = async (url, size) => {
      const txt = await (await fetch(url)).text();
      const sized = txt.replace('<svg ', '<svg width="' + size + '" height="' + size + '" ');
      const bu = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
      try { return await loadImg(bu); } finally { URL.revokeObjectURL(bu); }
    };
    const need = (u) => { if (!imgs.has(u)) imgs.set(u, loadImgSized(u, px)); };
    for (const f of frames) for (const t of f.tiles)
      need(tileUrl(t.t, f.win && f.win.cells.has(t.c + ',' + t.r) ? f.win.winner : null));
    for (const [u, p] of imgs) imgs.set(u, await p);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const renderFrame = (f) => {
      ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, W, H);
      for (const t of f.tiles) {
        const w = f.win && f.win.cells.has(t.c + ',' + t.r) ? f.win.winner : null;
        ctx.drawImage(imgs.get(tileUrl(t.t, w)), (t.c - c0) * px, (t.r - r0) * px, px, px);
      }
    };
    // Two passes for a global adaptive palette. Pass 1 renders every frame
    // only to accumulate a 5-bit-bucket colour histogram (no pixel retention,
    // so memory stays flat on phones); the palette is the 8 measured core
    // colours exact plus the most populous bucket means - anti-aliased edge
    // blends get real entries instead of nearest-core speckle. Pass 2
    // re-renders (drawImage is cheap next to LZW) and indexes.
    const bucketOf = (r, g, b2) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b2 >> 3);
    const hist = new Map();
    for (const f of frames) {
      renderFrame(f);
      const d = ctx.getImageData(0, 0, W, H).data;
      for (let j = 0; j < d.length; j += 4) {
        const bk = bucketOf(d[j], d[j + 1], d[j + 2]);
        let e = hist.get(bk); if (!e) hist.set(bk, e = { n: 0, r: 0, g: 0, b: 0 });
        e.n++; e.r += d[j]; e.g += d[j + 1]; e.b += d[j + 2];
      }
      await new Promise(r => setTimeout(r));
    }
    const pal = GIF_PAL.slice();
    const bucketIdx = new Map();
    for (let i = 0; i < pal.length; i++) bucketIdx.set(bucketOf(pal[i] >> 16, (pal[i] >> 8) & 255, pal[i] & 255), i);
    const ranked = [...hist.entries()].filter(([bk]) => !bucketIdx.has(bk)).sort((a, b2) => b2[1].n - a[1].n);
    for (const [bk, e] of ranked) {
      if (pal.length >= 256) break;
      bucketIdx.set(bk, pal.length);
      pal.push((Math.round(e.r / e.n) << 16) | (Math.round(e.g / e.n) << 8) | Math.round(e.b / e.n));
    }
    while (pal.length < 256) pal.push(0);
    const memo = new Map();
    const nearest256 = (r, g, b2) => {
      const bk = bucketOf(r, g, b2);
      let v = bucketIdx.get(bk); if (v !== undefined) return v;
      v = memo.get(bk); if (v !== undefined) return v;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < 256; i++) {
        const p = pal[i], dr = r - (p >> 16), dg = g - ((p >> 8) & 255), db = b2 - (p & 255);
        const dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; bi = i; }
      }
      memo.set(bk, bi); return bi;
    };
    const out = [];
    const b = (...xs) => out.push(...xs);
    b(71, 73, 70, 56, 57, 97);                       // GIF89a
    b(W & 255, W >> 8, H & 255, H >> 8, 0xF7, 0, 0); // GCT: 256 entries
    for (let i = 0; i < 256; i++) { const p = pal[i]; b(p >> 16, (p >> 8) & 255, p & 255); }
    b(0x21, 0xFF, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0); // loop forever
    for (let fi = 0; fi < frames.length; fi++) {
      renderFrame(frames[fi]);
      const data = ctx.getImageData(0, 0, W, H).data;
      const idx = new Uint8Array(W * H);
      for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = nearest256(data[j], data[j + 1], data[j + 2]);
      const delay = fi === frames.length - 1 ? 350 : 50; // 0.5s frames, 3.5s final hold
      b(0x21, 0xF9, 4, 0, delay & 255, delay >> 8, 0, 0);
      b(0x2C, 0, 0, 0, 0, W & 255, W >> 8, H & 255, H >> 8, 0, 8);
      gifSubBlocks(gifLzw(idx, 8), out);
      if (fi % 5 === 0) logEngine('# gif: frame ' + (fi + 1) + '/' + frames.length);
      await new Promise(r => setTimeout(r)); // keep the UI breathing
    }
    b(0x3B);
    const blob = new Blob([new Uint8Array(out)], { type: 'image/gif' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'trax-' + (state.variant || 'game') + '-' + total + 'ply.gif';
    a.click(); URL.revokeObjectURL(a.href);
    logEngine('# gif: saved ' + frames.length + ' frames (' + W + 'x' + H + ', 256c)');
  } catch (e) { showErr('gif export failed: ' + e.message); }
  btn.disabled = false;
}

// Harness-tolerant wiring: uicheck's DOM stub predates this button.
{ const sg = $('savegif'); if (sg) sg.addEventListener('click', saveGif); }
$('commitbtn').addEventListener('click', commit);
// Right-click commits: with a preview staged, the second hand never has to
// travel to the button - left cycles, right confirms. The browser's context
// menu is suppressed on the board only (it stays available elsewhere), and
// with no preview staged a right-click is simply ignored. On Android a
// long-press fires contextmenu, so touch players get press-and-hold-to-commit
// for free; iOS does not emit the event and keeps the button as the only path.
$('board').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!$('commitbtn').disabled) commit();
});
$('movebox').addEventListener('input', () => { previewTyped(); });
$('movebox').addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
$('newbtn').addEventListener('click', newGame);
if ($('histback')) $('histback').addEventListener('click', () => {
  const total = state ? (state.moves || []).length : 0;
  setView((viewPly === null ? total : viewPly) - 1);
});
if ($('histfwd')) $('histfwd').addEventListener('click', () => {
  if (viewPly !== null) setView(viewPly + 1);
});
if ($('histfirst')) $('histfirst').addEventListener('click', () => {
  const total = state ? (state.moves || []).length : 0;
  if (total > 0) setView(1);
});
if ($('histlast')) $('histlast').addEventListener('click', () => setView(null));
// The fit-to-column tile sizing depends on the window: re-render on resize
// (cheap - the board is a few hundred nodes) so tiles grow back when space does.
if (typeof window !== 'undefined' && window.addEventListener) {
  let rsz = null;
  window.addEventListener('resize', () => {
    if (rsz) clearTimeout(rsz);
    rsz = setTimeout(() => { rsz = null; render(); }, 120);
  });
}

// Keyboard arrows browse history whenever the game has moves - including from
// the live position of a running game (Left steps into the past; Right walks
// back to live). They never fire while typing in an input, where arrows must
// keep moving the caret. Display-only, like everything else here.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (!state) return;
  const total = (state.moves || []).length;
  if (!total) return;
  e.preventDefault();
  if (e.key === 'ArrowLeft') setView((viewPly === null ? total : viewPly) - 1);
  else if (viewPly !== null) setView(viewPly + 1);
});
$('variant').addEventListener('change', async () => {
  const v = $('variant').value;
  if (thinking) { spawnWorker(); } // cancel any think before switching rules
  const r = await send('VARIANT ' + v);
  viewPly = null; viewData = null; snapshots = {};
  refreshKnowledge();
  $('enginelog').textContent = '';
  logEngine(`Variant: ${v} (${v.endsWith('-draw') ? 'no legal moves = draw' : 'last player loses'}) - new game.`);
  onState(r);
  maybeEngine();
});
$('savebtn').addEventListener('click', saveGame);
$('loadbtn').addEventListener('click', loadGame);
$('loadfile').addEventListener('change', loadFile);
$('tilesize').addEventListener('change', render);
$('optforced').addEventListener('change', render);

// ---- pondering: think on the human's time -----------------------------------
// While the human considers, the engine runs short PONDER slices that fill the
// session's persistent transposition table; the eventual reply then starts on
// a warm table. Slices (not one long search) keep the single-threaded worker
// responsive - the human's move is never queued behind a deep ponder.
let ponderTimer = null;
const ponderBox = $('optponder'); // absent in the headless harness
function ponderOn() { return !!(ponderBox && ponderBox.checked); }
let ponderDepth = 0;
let ponderSliceMs = 150; // adaptive: grows on plateau, resets on progress
// ---- history browsing: display-only time travel -----------------------------
// viewPly = null means live; k means "show the board after the first k moves".
// The position comes from the read-only HIST command (a scratch-game replay in
// the wasm); the session's game, TT, pondering and clocks are never touched,
// and input is blocked while viewing so a click on an old board cannot play.
let viewPly = null;
let viewData = null;
async function setView(k) {
  const total = state ? (state.moves || []).length : 0;
  if (k === null || k >= total) { viewPly = null; viewData = null; render(); return; }
  k = Math.max(1, k); // never the empty board: move 1 is the earliest view
  const snap = snapshots[k];
  if (snap) { // instant, engine-independent path
    viewPly = k;
    viewData = { ok: true, hist: k, total, last: snap.last, tiles: snap.tiles, bbox: snap.bbox };
    render();
    return;
  }
  try {
    const d = await send('HIST ' + k); // waits if the engine is mid-think
    if (d && d.ok) { viewPly = k; viewData = d; snapshots[k] = { tiles: d.tiles, bbox: d.bbox, last: d.last }; }
  } catch { /* keep current view */ }
  render();
}
const ponderStat = $('ponderstatus'); // absent in the headless harness
function setPonderStat(t) { if (ponderStat) ponderStat.textContent = t; }
function ponderLoop() {
  ponderTimer = null;
  // Seat-at-the-table rule (same as the CLI): no engine side, no pondering -
  // human vs human must not pin a core, and there is no engine turn coming
  // to spend the warmth on.
  if (!ponderOn() || thinking || !state || state.over || !humanToMove() || !worker || !machineSides().size) { setPonderStat(''); return; }
  send('PONDER ' + ponderSliceMs).then((r) => {
    try {
      const d = JSON.parse(r);
      if (d && d.depth > ponderDepth) {
        ponderDepth = d.depth;
        ponderSliceMs = 150;
        setPonderStat(`\u23f3 pondering: depth ${d.depth} \u00b7 ${d.tt.toLocaleString()} positions`);
        logEngine(`# pondering on your time: depth ${d.depth}, table ${d.tt} positions`);
      } else {
        ponderSliceMs = Math.min(ponderSliceMs * 2, 2000);
      }
    } catch { /* non-JSON: ignore */ }
    if (!thinking && humanToMove()) ponderTimer = setTimeout(ponderLoop, 30);
  }).catch(() => {});
}
function schedulePonder() {
  ponderDepth = 0;
  ponderSliceMs = 150;
  setPonderStat('');
  if (ponderTimer) { clearTimeout(ponderTimer); ponderTimer = null; }
  if (ponderOn()) ponderTimer = setTimeout(ponderLoop, 250);
}
if (ponderBox) ponderBox.addEventListener('change', schedulePonder);
$('optoutput').checked = localStorage.getItem('trax-output') !== '0'; // survives deploys; default on
$('enginepane').hidden = !$('optoutput').checked;
$('optoutput').addEventListener('change', () => {
  localStorage.setItem('trax-output', $('optoutput').checked ? '1' : '0');
  $('enginepane').hidden = !$('optoutput').checked;
});
// Clicking anywhere outside the board deselects: the staged move and its
// forced-cascade preview vanish (standard deselect UX). The commit button is
// the one outside-the-board element that must NOT clear - it consumes the
// staging instead.
document.addEventListener('click', (e) => {
  if (!preview && !previewCell) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && (t.closest('#board') || t.closest('#commitbtn'))) return;
  preview = null; previewCell = null; $('commitbtn').disabled = true; render();
});

for (const el of document.querySelectorAll('input[name=mode]')) {
  el.addEventListener('change', () => {
    // A staged-but-uncommitted human move is orphaned by a mode switch: if
    // the seat that staged it is no longer human, the marked tile and its
    // forced-cascade preview would linger on the board as ghosts outside
    // the move history (field case: stage, switch to Two Machines, watch
    // the engine play around your phantom tiles). Sweep the staging.
    if (preview || previewCell) {
      preview = null; previewCell = null; $('commitbtn').disabled = true;
    }
    $('status').textContent = statusLine(); render(); maybeEngine();
  });
}

// ---------- day/night mode ----------------------------------------------------
// First visit follows the system preference; the toggle overrides and persists.
const themeBtn = $('themebtn');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19'; // sun / moon
}
let theme = localStorage.getItem('trax-theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('trax-theme', theme);
  applyTheme(theme);
});

spawnWorker();
