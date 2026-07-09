// Trax web UI. All game logic and validation live in the wasm engine (worker.js);
// this file renders state, translates clicks/typing into protocol lines, and
// drives the engine per the selected mode. Tile GIFs come from tiles/red/<size>/,
// win-path tiles from tiles/red/<size>/win/<white|black>/.

'use strict';

const $ = (id) => document.getElementById(id);
const SIZES = { small: 40, medium: 60, large: 80 };

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
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.fatal) { $('status').textContent = 'Engine failed to load: ' + d.fatal; return; }
    if (d.ready) {
      queuedKnowledge = `${d.threats} threat pattern(s), ${d.book} book position(s)`;
      $('knowledge').textContent = queuedKnowledge;
      send('STATE').then(onState).then(maybeEngine);
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
  const base = `tiles/red/${size}/`;
  return winner ? `${base}win/${winner}/${kind}.gif` : `${base}${kind}.gif`;
}

function render() {
  const board = $('board');
  board.innerHTML = '';
  if (!state) return;
  const size = $('tilesize').value;
  const px = SIZES[size];
  const showForced = $('optforced').checked;

  // Grid = bounding box plus one placement ring - but only on axes that can still
  // grow: at 8 tiles wide no move can exist left or right of the board, so showing
  // ring columns there would suggest placements the rules forbid. Same for rows.
  const bb = state.bbox || { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 };
  const colPad = state.bbox && (bb.maxCol - bb.minCol + 1) < 8 ? 1 : 0;
  const rowPad = state.bbox && (bb.maxRow - bb.minRow + 1) < 8 ? 1 : 0;
  const c0 = bb.minCol - colPad, c1 = bb.maxCol + colPad;
  const r0 = bb.minRow - rowPad, r1 = bb.maxRow + rowPad;
  const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
  board.style.gridTemplateColumns = `repeat(${cols}, ${px}px)`;
  board.style.gridTemplateRows = `repeat(${rows}, ${px}px)`;

  const tiles = new Map(state.tiles.map((t) => [`${t.c},${t.r}`, t.t]));
  const winCells = new Set((state.winCells || []).map((w) => `${w.c},${w.r}`));
  const winner = state.result === 'white' ? 'white' : state.result === 'black' ? 'black' : null;
  const legalByCell = new Map();
  for (const m of state.legal || []) {
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
      if (prev && !placedKind) {
        // preview tile: the chosen one plain-preview, cascade tiles glowing
        const img = document.createElement('img');
        img.src = tileUrl(prev.t, size, null);
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
        img.src = tileUrl(placedKind, size, asWin);
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
      } else if (legalByCell.has(key) && !state.over && !thinking && humanToMove()) {
        cell.classList.add('playable');
        cell.title = legalByCell.get(key).map((m) => m.n).join('  ');
        cell.addEventListener('click', () => cycleCell(c, r));
      }
      board.appendChild(cell);
    }
  }
}

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
    const w = state.result === 'white' ? 'White' : 'Black';
    return `Game over: ${w} wins (${state.reason}).`;
  }
  const side = state.toMove === 'W' ? 'White' : 'Black';
  const who = machineSides().has(state.toMove) ? 'engine' : 'you';
  return thinking
    ? `Move ${state.moveCount + 1} - ${side} (engine) is thinking\u2026`
    : `Move ${state.moveCount + 1} - ${side} to move (${who}).`;
}

function onState(r) {
  if (!r.ok) { showErr(r.error); return r; }
  state = r;
  preview = null;
  previewCell = null;
  $('movebox').value = '';
  $('commitbtn').disabled = true;
  showErr('');
  $('history').textContent = (state.moves || []).join(' ') || '(no moves yet)';
  if (r.engine && r.engine.lines && $('optoutput').checked) {
    logEngine(`played ${r.engine.move}  (${(r.engine.ms / 1000).toFixed(1)}s, ${r.engine.nodes} nodes, book hits ${r.engine.bookHits})`);
  }
  $('status').textContent = statusLine();
  render();
  return r;
}

function showErr(msg) { $('moveerr').textContent = msg || ''; }

function logEngine(line) {
  const pre = $('enginelog');
  pre.textContent += line + '\n';
  pre.scrollTop = pre.scrollHeight;
}

// ---------- input: click-to-cycle ------------------------------------------

async function cycleCell(c, r) {
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
  const p = await send('PREVIEW ' + tok);
  if (!p.ok) { preview = null; $('commitbtn').disabled = true; showErr(p.error); render(); return; }
  preview = p;
  previewCell = null;
  $('commitbtn').disabled = false;
  showErr('');
  render();
}

async function commit() {
  if (!preview || thinking || !humanToMove()) return;
  const r = await send('PLAY ' + preview.notation);
  if (!r.ok) { showErr(r.error); return; }
  onState(r);
  maybeEngine();
}

// ---------- engine driving ---------------------------------------------------

async function maybeEngine() {
  if (!state || state.over || thinking) return;
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

function loadGame() { $('loadfile').click(); }

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
$('savebtn').addEventListener('click', saveGame);
$('loadbtn').addEventListener('click', loadGame);
$('loadfile').addEventListener('change', loadFile);
$('tilesize').addEventListener('change', render);
$('optforced').addEventListener('change', render);
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
