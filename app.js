// Trax web UI. All game logic and validation live in the wasm engine (worker.js);
// this file renders state, translates clicks/typing into protocol lines, and
// drives the engine per the selected mode. Tile GIFs come from tiles/red/<size>/,
// win-path tiles from tiles/red/<size>/win/<white|black>/.

'use strict';

const $ = (id) => document.getElementById(id);
const SIZES = { small: 40, medium: 60, large: 80 };

// Warm the tile cache: embedded-webview asset servers can drop some of the
// dozens of simultaneous <img> requests a board render fires, leaving broken
// tiles. Preloading the current size's 18 tiles once (sequentially, at idle)
// makes every later render a memory-cache hit - immune to render churn.
const KINDS = ['es', 'nw', 'ns', 'ew', 'sw', 'en'];
function warmTiles(size) {
  if (typeof Image === 'undefined') return;
  const urls = [];
  for (const k of KINDS) {
    urls.push(tileUrl(k, size, null), tileUrl(k, size, 'white'), tileUrl(k, size, 'black'));
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
      // The ready counts describe the boot (8x8) session; if the page is on a
      // different variant, ask the post-switch session for ITS counts.
      if ($('variant').value !== '8x8') refreshKnowledge();
      // A fresh worker session starts at the default variant; re-assert the page's
      // selection so respawns (New Game during a think, mode changes) keep the rules.
      const v = $('variant').value;
      (v !== '8x8' ? send('VARIANT ' + v) : send('STATE')).then(onState).then(maybeEngine);
      return;
    }
    if (d.depth !== undefined) { logEngine(d.depth); return; }
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

function tileUrl(kind, size, winner) {
  // The GIF tile set (the original board look) ships inside the tree at
  // web/tiles - every build stays self-contained, no external assets to forget.
  const base = `tiles/red/${size}/`;
  return winner ? `${base}win/${winner}/${kind}.gif` : `${base}${kind}.gif`;
}

function render() {
  const board = $('board');
  board.innerHTML = '';
  if (!state) return;
  const size = $('tilesize').value;
  const px = SIZES[size];
  if (size !== warmTiles.done) { warmTiles.done = size; warmTiles(size); }
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
  board.style.gridTemplateColumns = `repeat(${cols}, ${px}px)`;
  board.style.gridTemplateRows = `repeat(${rows}, ${px}px)`;

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
      cell.style.width = px + 'px';
      cell.style.height = px + 'px';
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
        tileImg(img).src = tileUrl(prev.t, size, null);
        img.className = prev.forced && showForced ? 'tile forced' : 'tile preview';
        img.draggable = false;
        cell.appendChild(img);
        // Clicking the previewed (uncommitted) tile cycles to the next candidate
        // geometry at that cell. Only the anchor tile cycles; forced-cascade
        // previews are consequences, not choices.
        if (!prev.forced && humanToMove() && !thinking) {
          cell.classList.add('playable');
          cell.addEventListener('click', () => cycleCell(c, r));
        }
      } else if (placedKind) {
        const img = document.createElement('img');
        const asWin = winner && winCells.has(key) ? winner : null;
        tileImg(img).src = tileUrl(placedKind, size, asWin);
        img.className = 'tile';
        img.draggable = false;
        // a committed tile being re-covered by a forced cascade in the preview
        if (prev && prev.forced && showForced) {
          const ov = document.createElement('img');
          ov.src = tileUrl(prev.t, size, null);
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
function onState(r) {
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
  }
  $('status').textContent = statusLine();
  render();
  return r;
}

function showErr(msg) { $('moveerr').textContent = msg || ''; }

let engineBuild = '';
function knowledgeLine(d) {
  return `${d.threats} threat pattern(s), ${d.book} book position(s)`
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
  if (thinking) { // ---------- day/night mode ----------------------------------------------------
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

spawnWorker(); $('enginelog').textContent = ''; return; } // cancels the think, re-inits
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

$('commitbtn').addEventListener('click', commit);
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
$('optoutput').addEventListener('change', () => { $('enginepane').hidden = !$('optoutput').checked; });
for (const el of document.querySelectorAll('input[name=mode]')) {
  el.addEventListener('change', () => { $('status').textContent = statusLine(); render(); maybeEngine(); });
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
