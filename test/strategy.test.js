import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../strategy.js';
const { freshState, step, P } = __test;

// Serie sintética determinista con tendencias y retrocesos (sin red).
function series(n, seed = 7) {
  let x = seed, price = 100, drift = 0.0006; const bars = []; const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) drift = (rnd() - 0.45) * 0.0012;
    const o = price, c = o * (1 + drift + (rnd() - 0.5) * 0.004), h = Math.max(o, c) * (1 + rnd() * 0.0015), l = Math.min(o, c) * (1 - rnd() * 0.0015);
    bars.push({ t: 1_700_000_000 + i * 300, o, h, l, c }); price = c;
  }
  return bars;
}

test('estrategia: el corte parcial sale una vez por posición, tras abrir y antes de cerrar', () => {
  const s = freshState(), sig = []; step(s, series(20000), x => sig.push(x));
  const opens = sig.filter(x => x.action === 'open'), reduces = sig.filter(x => x.action === 'reduce');
  assert.ok(opens.length > 20 && reduces.length > 5, `señales insuficientes: ${opens.length} aperturas, ${reduces.length} cortes`);
  const idx = id => sig.findIndex(x => x.posId === id && x.action === 'open');
  const seen = new Set(), closed = new Set();
  for (const x of sig) {
    if (x.action === 'close') closed.add(x.posId);
    if (x.action === 'reduce') {
      assert.ok(idx(x.posId) >= 0 && idx(x.posId) < sig.indexOf(x), 'reduce sin apertura previa');
      assert.ok(!seen.has(x.posId), 'posición reducida dos veces'); seen.add(x.posId);
      assert.ok(!closed.has(x.posId), 'reduce después del cierre');
      assert.equal(x.frac, P.PCUT);
    }
  }
  assert.equal(new Set(sig.map(x => x.id)).size, sig.length, 'ids de señal repetidos');
});

test('estrategia: el corte nunca se emite con la posición ya armada (break-even)', () => {
  const s = freshState(); let bad = 0;
  step(s, series(20000, 11), x => { if (x.action === 'reduce') { const p = s.open.find(q => q.posId === x.posId); if (p && p.armed) bad++; } });
  assert.equal(bad, 0);
});

test('estrategia: el calentamiento (emit=null) marca preDone sin emitir señales', () => {
  const s = freshState(); step(s, series(6000, 3), null);
  assert.ok(s.open.every(p => typeof p.preDone === 'boolean'));
});
