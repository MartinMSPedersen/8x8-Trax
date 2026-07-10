// Web Worker hosting the Trax wasm engine. The main thread stays responsive while
// the engine thinks (up to 120s); per-depth reports stream out live through the
// js_on_depth import. Protocol: postMessage({id, line}) in, {id, resp} out, plus
// unsolicited {depth: "..."} lines during ENGINE calls and one {ready} after init.

'use strict';

// The knowledge files served alongside the page (repo root). Directory listings
// don't exist on GitHub Pages, so the threat file names are configured here -
// keep in sync with the threat/ directory. Missing files degrade gracefully.
const THREAT_FILES = ['3stage.txt', 'L-threats.txt', 'all.txt', 'edge.txt', 'threats.txt'];

let ex = null;
let enc = new TextEncoder();
let dec = new TextDecoder();

function mem() { return new Uint8Array(ex.memory.buffer); }
function put(str) {
  const b = enc.encode(str);
  const p = ex.tx_alloc(b.length || 1);
  if (b.length) mem().set(b, p);
  return { p, len: b.length };
}
function resp(len) {
  const base = ex.tx_resp_ptr();
  return dec.decode(mem().slice(base, base + len));
}
function call(line) {
  const { p, len } = put(line);
  const rl = ex.tx_call(p, len);
  ex.tx_dealloc(p, len || 1);
  return resp(rl);
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? await r.text() : '';
  } catch (e) { return ''; }
}

async function boot() {
  const [wasmBytes, always, never, replies, evalc, ...threatParts] = await Promise.all([
    fetch('trax.wasm', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error('trax.wasm not found next to index.html');
      return r.arrayBuffer();
    }),
    fetchText('book/alwaysplay.trx'),
    fetchText('book/neverplay.trx'),
    fetchText('book/replies.txt'),
    fetchText('eval.conf'),
    ...THREAT_FILES.map((f) => fetchText('threat/' + f)),
  ]);
  const threats = threatParts.join('\n');

  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {
      js_now_ms: () => performance.now(), // monotonic - immune to wall-clock jumps mid-think
      js_on_depth: (ptr, len) => {
        const line = dec.decode(new Uint8Array(instance.exports.memory.buffer).slice(ptr, ptr + len));
        postMessage({ depth: line });
      },
    },
  });
  ex = instance.exports;

  const bufs = [threats, always, never, replies, evalc].map(put);
  const il = ex.tx_init(bufs[0].p, bufs[0].len, bufs[1].p, bufs[1].len, bufs[2].p, bufs[2].len, bufs[3].p, bufs[3].len, bufs[4].p, bufs[4].len);
  const initR = JSON.parse(resp(il));
  bufs.forEach((b) => ex.tx_dealloc(b.p, b.len || 1));
  if (!initR.ok) throw new Error('engine init failed: ' + initR.error);
  let build = '';
  try { build = JSON.parse(call('VERSION')).build || ''; } catch (e) { /* older wasm */ }
  postMessage({ ready: true, threats: initR.threats, book: initR.book, replies: initR.replies || 0, build });
}

const queue = [];
let booted = false;

onmessage = (e) => {
  if (!booted) { queue.push(e.data); return; }
  const { id, line } = e.data;
  const r = call(line);
  postMessage({ id, resp: r });
};

boot().then(() => {
  booted = true;
  for (const m of queue) {
    const r = call(m.line);
    postMessage({ id: m.id, resp: r });
  }
}).catch((err) => {
  postMessage({ fatal: String(err && err.message || err) });
});
