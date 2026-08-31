// Exploratory fuzzer: hunt for the "start argument out of range" invariant
// break in @xterm/headless 6.0.0 by interleaving TUI-like byte streams with
// resizes, the way a busy tmux pane + FitAddon do in PocketShell.
//
//   node scripts/xterm-fuzz.mjs [startSeed] [seeds] [scrollback]
import headless from '@xterm/headless';
const { Terminal } = headless;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const startSeed = Number(process.argv[2] ?? 1);
const seedCount = Number(process.argv[3] ?? 200);
const scrollback = Number(process.argv[4] ?? 9001);

let found = 0;
// A sync throw inside xterm's parse loop escapes via setTimeout, so it arrives
// here instead of the write callback. Record it and keep fuzzing other seeds.
let uncaught = null;
process.on('uncaughtException', (err) => { uncaught = err; });

const writeChunk = (term, data) => new Promise((resolve) => {
  term.write(data, resolve);
  // xterm's write callback can also be skipped when the chunk itself throws;
  // uncaughtException then fires. Resolve on next tick so the handler sees it.
  setImmediate(() => resolve());
});

for (let seed = startSeed; seed < startSeed + seedCount; seed++) {
  const rnd = mulberry32(seed);
  let cols = 20 + Math.floor(rnd() * 100);
  let rows = 8 + Math.floor(rnd() * 30);
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const ops = [];
  const log = (s) => { ops.push(s); if (ops.length > 40) ops.shift(); };

  try {
    const batches = 300 + Math.floor(rnd() * 700);
    for (let b = 0; b < batches; b++) {
      // A batch of TUI-ish output, like one frame from a redraw-happy agent TUI.
      const n = 5 + Math.floor(rnd() * 40);
      let out = '';
      for (let i = 0; i < n; i++) {
        const pick = rnd();
        if (pick < 0.18) {
          // long wrapped text (the thing reflow chews on)
          const words = 20 + Math.floor(rnd() * 120);
          for (let w = 0; w < words; w++) out += (rnd() * 10 | 0) + ' ';
          out += '\r\n';
          log(`text(${words}w)`);
        } else if (pick < 0.26) {
          const top = 1 + Math.floor(rnd() * (rows - 1));
          let bottom = top + Math.floor(rnd() * (rows - top));
          out += `\x1b[${top};${bottom}r`;
          log(`DECSTBM(${top},${bottom})`);
        } else if (pick < 0.34) {
          out += '\x1bM'; log('RI');
        } else if (pick < 0.40) {
          out += '\x1bD'; log('IND');
        } else if (pick < 0.46) {
          const k = 1 + Math.floor(rnd() * 5);
          out += `\x1b[${k}L`; log(`IL(${k})`);
        } else if (pick < 0.52) {
          const k = 1 + Math.floor(rnd() * 5);
          out += `\x1b[${k}M`; log(`DL(${k})`);
        } else if (pick < 0.58) {
          const y = 1 + Math.floor(rnd() * rows);
          const x = 1 + Math.floor(rnd() * cols);
          out += `\x1b[${y};${x}H`; log(`CUP(${y},${x})`);
        } else if (pick < 0.62) {
          out += '\x1b7'; log('DECSC');
        } else if (pick < 0.66) {
          out += '\x1b8'; log('DECRC');
        } else if (pick < 0.70) {
          out += '\r'; log('CR');
        } else if (pick < 0.76) {
          out += '\n'.repeat(1 + (rnd() * 3 | 0)); log('LFxN');
        } else if (pick < 0.80) {
          out += '\x1b[c'; log('DA');
        } else if (pick < 0.84) {
          const s = 1 + Math.floor(rnd() * 3);
          out += rnd() < 0.5 ? `\x1b[${s}S` : `\x1b[${s}T`; log('SU/SD');
        } else if (pick < 0.88) {
          out += rnd() < 0.5 ? '\x1b[?1049h' : '\x1b[?1049l'; log('ALTBUF');
        } else if (pick < 0.92) {
          out += '\x1b[2J'; log('ED2');
        } else if (pick < 0.96) {
          out += rnd() < 0.5 ? '\x1b[?1007l' : '\x1b[?1007h'; log('alt-scr');
        } else {
          out += `\x1b[${1 + (rnd() * 4 | 0)};3${rnd() * 7 | 0}m`; log('SGR');
        }
      }
      await writeChunk(term, out);
      if (uncaught) throw uncaught;

      // The viewport-invariant checkpoint: between chunks it must hold, or the
      // next RI/scroll shiftElements gets an out-of-range start.
      const b = term._core.buffer;
      if (b.lines.length < b.ybase + b.rows) {
        throw new Error(`INVARIANT len=${b.lines.length} < ybase=${b.ybase} + rows=${b.rows}`);
      }

      // The resize that races the stream, like FitAddon firing between chunks.
      if (rnd() < 0.5) {
        const nc = Math.max(2, cols + Math.floor((rnd() - 0.5) * 60));
        const nr = Math.max(2, rows + Math.floor((rnd() - 0.5) * 16));
        term.resize(nc, nr);
        cols = nc; rows = nr;
        log(`RESIZE(${nc},${nr})`);
        if (term._core.buffer.lines.length < term._core.buffer.ybase + term._core.buffer.rows) {
          const b2 = term._core.buffer;
          throw new Error(`INVARIANT-after-resize len=${b2.lines.length} < ybase=${b2.ybase} + rows=${b2.rows}`);
        }
      }
    }
  } catch (err) {
    found++;
    console.log(`seed=${seed} scrollback=${scrollback}`);
    console.log(`  ${err.message}`);
    console.log(`  ${err.stack?.split('\n').slice(1, 4).join('\n  ')}`);
    console.log(`  buffer: len=${term.buffer.active.length} baseY=${term.buffer.active.baseY} cursorY=${term.buffer.active.cursorY} viewportY=${term.buffer.active.viewportY} cols=${term.cols} rows=${term.rows}`);
    console.log(`  last ops: ${ops.join(' | ')}`);
    uncaught = null;
    if (found >= 5) break;
  } finally {
    term.dispose();
  }
}
console.log(`done: ${found} failures over seeds ${startSeed}..${startSeed + seedCount - 1}`);
