import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCfg, freshPaper, copySize, applyItem, summary, solbotTick, isAddr, START_SOL } from '../solbot.js';

const M1 = 'So11111111111111111111111111111111111111112', M2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const cfg = (o = {}) => normalizeCfg({ mode: 'fixed', fixedSol: 0.5, maxPerTradeSol: 1, maxTotalSol: 3, ...o });
const buy = (sig, extra = {}) => ({ sig, at: 2000, side: 'buy', mint: M2, sol: 2, priceSol: 0.001, sym: 'BONK', ...extra });
const sell = (sig, extra = {}) => ({ sig, at: 3000, side: 'sell', mint: M2, sellFrac: 1, priceSol: 0.001, sym: 'BONK', ...extra });

test('normalizeCfg impone límites duros y valores por defecto', () => {
  const c = normalizeCfg({ mode: 'x', fixedSol: 999, ratio: -5, maxPerTradeSol: 'abc', maxTotalSol: 1e9, buys: false });
  assert.equal(c.mode, 'fixed'); assert.equal(c.fixedSol, 5); assert.equal(c.ratio, 0.01); assert.equal(c.maxPerTradeSol, 1); assert.equal(c.maxTotalSol, 10); assert.equal(c.buys, false); assert.equal(c.sells, true);
  assert.deepEqual(normalizeCfg(null), normalizeCfg({}));
});
test('isAddr valida base58 de 32 a 44', () => { assert.ok(isAddr(M2)); assert.ok(!isAddr('abc')); assert.ok(!isAddr('0'.repeat(40))); assert.ok(!isAddr(null)); });

test('copySize: modo fijo, proporcional y topes', () => {
  const p = freshPaper();
  assert.equal(copySize(cfg(), 5, p).sol, 0.5);
  assert.equal(copySize(cfg({ mode: 'ratio', ratio: 0.1 }), 5, p).sol, 0.5);
  assert.equal(copySize(cfg({ fixedSol: 5, maxPerTradeSol: 1 }), 5, p).sol, 1);          // tope por operación
  p.positions[M1] = { mint: M1, qty: 1, cost: 2.8 };
  assert.ok(Math.abs(copySize(cfg({ fixedSol: 1 }), 5, p).sol - 0.2) < 1e-9);               // tope total: solo caben 0.2
  p.positions[M1].cost = 3; assert.match(copySize(cfg(), 5, p).skip, /total limit/);
});

test('compra: descuenta comisión y deslizamiento y reduce el saldo virtual', () => {
  const p = freshPaper(); assert.equal(applyItem(p, cfg(), buy('s1'), 0), true);
  assert.equal(p.cash, START_SOL - 0.5); const pos = p.positions[M2];
  assert.ok(Math.abs(pos.qty - (0.5 * (1 - 0.011)) / (0.001 * 1.01)) < 1e-9); assert.equal(pos.cost, 0.5);
});
test('vender al mismo precio pierde comisión y deslizamiento: nunca sale gratis', () => {
  const p = freshPaper(); applyItem(p, cfg(), buy('s1'), 0); applyItem(p, cfg(), sell('s2'), 0);
  assert.equal(Object.keys(p.positions).length, 0); assert.ok(p.realized < 0, 'ida y vuelta al mismo precio debe perder'); assert.ok(p.realized > -0.05);
  assert.ok(Math.abs(p.cash + 0 - (START_SOL + p.realized)) < 1e-9);
});
test('venta parcial de la fuente vende la misma fracción', () => {
  const p = freshPaper(); applyItem(p, cfg(), buy('s1'), 0); const q0 = p.positions[M2].qty;
  applyItem(p, cfg(), sell('s2', { sellFrac: 0.4 }), 0);
  assert.ok(Math.abs(p.positions[M2].qty - q0 * 0.6) < 1e-9); assert.ok(Math.abs(p.positions[M2].cost - 0.3) < 1e-9);
});
test('idempotente por sig y respeta since (no copia lo anterior a la conexión)', () => {
  const p = freshPaper(); assert.equal(applyItem(p, cfg(), buy('s1', { at: 500 }), 1000 * 1000 /* since */), false);
  assert.equal(applyItem(p, cfg(), buy('s2'), 0), true); const cash = p.cash;
  assert.equal(applyItem(p, cfg(), buy('s2'), 0), false); assert.equal(p.cash, cash);
});
test('ajustes buys/sells desactivados, datos inservibles y venta sin posición no rompen nada', () => {
  const p = freshPaper();
  applyItem(p, cfg({ buys: false }), buy('a'), 0); assert.equal(p.cash, START_SOL);
  applyItem(p, cfg(), buy('b', { priceSol: 0 }), 0); applyItem(p, cfg(), buy('c', { mint: 'mal' }), 0); assert.equal(p.cash, START_SOL);
  applyItem(p, cfg(), sell('d'), 0); assert.equal(p.realized, 0);
  applyItem(p, cfg({ sells: false }), buy('e'), 0); applyItem(p, cfg({ sells: false }), sell('f'), 0); assert.ok(p.positions[M2]);
});
test('summary: equity = saldo + posiciones valoradas al último precio', () => {
  const p = freshPaper(); applyItem(p, cfg(), buy('s1'), 0); p.last[M2] = 0.002;   // el precio se duplica
  const s = summary(p); assert.ok(s.unrealized > 0.4 && s.pnlPct > 0); assert.ok(Math.abs(s.equity - (s.cash + s.positions[0].valueSol)) < 1e-3);
});

function fakeStore(users) { const kv = { 'solbot:users': users }; return { kv, kvGet: async (k, d) => (k in kv && kv[k] != null ? kv[k] : d), kvSet: async (k, v) => { kv[k] = v; } }; }
const W = M2;
test('ciclo: aplica solo a usuarios activos, no repite y respeta el interruptor general', async () => {
  const store = fakeStore({ u1: { wallet: W, active: true, since: 0, cfg: {} }, u2: { wallet: M1, active: false, since: 0, cfg: {} } });
  const feed = { signal: { on: true }, items: [sell('s2'), buy('s1')] };   // desordenado a propósito
  const deps = { store, fetchFeed: async () => feed, minGapMs: 0, gate: { last: 0 } };
  const r1 = await solbotTick(deps); assert.equal(r1.changedUsers, 1);
  const paper = store.kv['solbot:paper:u1']; assert.equal(Object.keys(paper.positions).length, 0); assert.equal(paper.trades.length, 2);   // compra y luego venta
  assert.equal(store.kv['solbot:paper:u2'], undefined, 'el usuario pausado no se toca');
  const r2 = await solbotTick(deps); assert.equal(r2.changedUsers, 0);
  feed.signal.on = false; feed.items.push(buy('s9', { at: 9000 })); assert.equal((await solbotTick(deps)).skipped, 'signal-off');
});
test('ciclo: un feed roto no cambia nada y el límite de frecuencia se respeta', async () => {
  const store = fakeStore({ u1: { wallet: W, active: true, since: 0, cfg: {} } });
  assert.equal((await solbotTick({ store, fetchFeed: async () => null, minGapMs: 0, gate: { last: 0 } })).error, 'feed');
  const g = { last: Date.now() }; assert.equal((await solbotTick({ store, fetchFeed: async () => ({ items: [] }), gate: g })).skipped, 'gap');
});
test('ciclo: si el usuario reconecta mientras se calcula, no se pisa su cuenta nueva', async () => {
  const store = fakeStore({ u1: { wallet: W, active: true, since: 0, cfg: {} } });
  const orig = store.kvGet; let reads = 0;
  store.kvGet = async (k, d) => { const v = await orig(k, d); if (k === 'solbot:users' && ++reads === 2) { store.kv['solbot:users'] = { u1: { wallet: M1, active: true, since: 5, cfg: {} } }; return store.kv['solbot:users']; } return v; };
  const r = await solbotTick({ store, fetchFeed: async () => ({ items: [buy('s1')] }), minGapMs: 0, gate: { last: 0 } });
  assert.equal(r.changedUsers, 0); assert.equal(store.kv['solbot:paper:u1'], undefined);
});
