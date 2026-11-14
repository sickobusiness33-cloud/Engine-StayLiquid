import test from 'node:test';
import assert from 'node:assert/strict';
import { clampFrac, reduceOrderId, planCut, isDuplicateError, executeReduce, shouldRetry, RETRY } from '../partial.js';

const rules = { min: 0.001, round: x => Math.floor(x * 1000) / 1000 };
function fakeLive({ failWith = null, rule = rules } = {}) {
  const log = [];
  const client = {
    cancelOrder: async id => log.push(['cancel', id]),
    createOrder: async (sym, type, side, amount, price, params) => { log.push(['stop', amount, params.stopPrice]); return { id: 'stop2' }; },
  };
  const ex = {
    amountRules: async () => rule,
    placeOrder: async (c, o) => { log.push(['order', o]); if (failWith) throw failWith; return { id: 'o1' }; },
  };
  return { live: { ex, client }, log };
}
const pos = (extra = {}) => ({ posId: 'p1-2', symbol: 'BTC/USDT', side: 'long', amount: 0.01, amountUsd: 1000, ...extra });

test('clampFrac acota y usa 0.5 por defecto', () => {
  assert.equal(clampFrac(0.5), 0.5); assert.equal(clampFrac(2), 0.95); assert.equal(clampFrac(0.001), 0.05);
  assert.equal(clampFrac(undefined), 0.5); assert.equal(clampFrac('x'), 0.5); assert.equal(clampFrac(-1), 0.5);
});

test('reduceOrderId es determinista, único por posición y cabe en 36 caracteres', () => {
  const a = reduceOrderId('u1', 'p1'), b = reduceOrderId('u1', 'p1'), c = reduceOrderId('u1', 'p2');
  assert.equal(a, b); assert.notEqual(a, c); assert.ok(a.length <= 36); assert.match(a, /^[a-z0-9]+$/);
});

test('planCut redondea y respeta mínimos', () => {
  assert.deepEqual(planCut(0.0105, 0.5, rules), { ok: true, cut: 0.005, rest: 0.0105 - 0.005 });
  assert.equal(planCut(0.001, 0.5, rules).reason, 'cut_rounds_to_zero');
  assert.equal(planCut(0.0015, 0.5, rules).reason, 'cut_rounds_to_zero');
  assert.equal(planCut(0.0021, 0.5, { min: 0.002, round: rules.round }).reason, 'cut_below_min');
  assert.equal(planCut(0.0045, 0.95, { min: 0.002, round: rules.round }).reason, 'rest_below_min');
  assert.equal(planCut(0, 0.5, rules).reason, 'no_amount');
});

test('isDuplicateError reconoce el rechazo por clientOrderId repetido', () => {
  assert.ok(isDuplicateError(new Error('binance {"code":-2010,"msg":"Duplicate order sent."}')));
  assert.ok(isDuplicateError({ name: 'DuplicateOrderId' }));
  assert.ok(!isDuplicateError(new Error('Insufficient margin')));
});

test('paper: corta la mitad una sola vez', async () => {
  const p = pos(); const deps = { mode: 'paper', live: null, persist: async () => {} };
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps });
  assert.equal(r.status, 'done'); assert.equal(p.amount, 0.005); assert.equal(p.amountUsd, 500); assert.equal(p.preCut, true);
  assert.equal((await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps })).status, 'noop');
  assert.equal(p.amount, 0.005);
});

test('live: orden reduceOnly con cantidad redondeada y la intención se guarda ANTES de enviar', async () => {
  const { live, log } = fakeLive(); const p = pos({ amount: 0.0107 });
  const deps = { mode: 'live', live, persist: async () => log.push(['persist', p.preCutInFlight]) };
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps });
  assert.equal(r.status, 'done');
  assert.equal(log[0][0], 'persist'); assert.ok(log[0][1], 'intención guardada antes de la orden');
  const order = log.find(x => x[0] === 'order')[1];
  assert.equal(order.amount, 0.005); assert.equal(order.side, 'sell'); assert.equal(order.params.reduceOnly, true);
  assert.equal(order.clientOrderId, reduceOrderId('u1', 'p1-2'));
  assert.equal(p.preCutInFlight, undefined); assert.equal(p.preCut, true);
  assert.ok(Math.abs(p.amount - 0.0057) < 1e-12);
});

test('live: si el exchange rechaza la orden, la posición NO cambia y se programa reintento', async () => {
  const { live } = fakeLive({ failWith: new Error('Insufficient margin') }); const p = pos();
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live, persist: async () => {} } });
  assert.equal(r.status, 'failed'); assert.match(r.error, /Insufficient margin/);
  assert.equal(p.amount, 0.01); assert.equal(p.amountUsd, 1000); assert.ok(!p.preCut); assert.ok(!p.preCutInFlight);
  assert.equal(p.reducePending.tries, 1);
});

test('reintentos acotados por número e tiempo', () => {
  const t0 = 1_000_000; const p = pos({ reducePending: { frac: 0.5, tries: 1, firstAt: t0, lastAt: t0 } });
  assert.equal(shouldRetry(p, t0 + 1000), false, 'demasiado pronto');
  assert.equal(shouldRetry(p, t0 + RETRY.minGapMs), true);
  p.reducePending.tries = RETRY.maxTries; assert.equal(shouldRetry(p, t0 + RETRY.minGapMs), false, 'agotados');
  p.reducePending.tries = 1; assert.equal(shouldRetry(p, t0 + RETRY.windowMs + 1), false, 'fuera de ventana');
  assert.equal(shouldRetry(pos({ reducePending: { frac: 0.5, tries: 1, firstAt: t0, lastAt: t0 }, preCut: true }), t0 + 9999), false);
});

test('live: un reintento tras fallo termina el corte', async () => {
  const bad = fakeLive({ failWith: new Error('timeout') }); const p = pos();
  await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live: bad.live, persist: async () => {} } });
  const ok = fakeLive();
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live: ok.live, persist: async () => {} } });
  assert.equal(r.status, 'done'); assert.equal(p.reducePending, undefined); assert.equal(p.amount, 0.005);
});

test('live: orden duplicada (reenvío tras caída) se da por hecha sin vender dos veces', async () => {
  const { live } = fakeLive({ failWith: new Error('Duplicate order sent.') }); const p = pos({ preCutInFlight: 'x' });
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live, persist: async () => {} } });
  assert.equal(r.status, 'done'); assert.equal(p.preCut, true); assert.equal(p.amount, 0.005);
});

test('live: bajo el mínimo no envía orden y no reintenta', async () => {
  const { live, log } = fakeLive(); const p = pos({ amount: 0.0015 });
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live, persist: async () => {} } });
  assert.equal(r.status, 'skipped'); assert.ok(!log.some(x => x[0] === 'order')); assert.equal(p.preCut, true); assert.equal(p.amount, 0.0015);
});

test('live: tras cortar, recoloca el stop en reposo con el tamaño que queda', async () => {
  const { live, log } = fakeLive(); const p = pos({ amount: 0.01, stop: 59000, stopOrderId: 'stop1' });
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live, persist: async () => {} } });
  assert.equal(r.status, 'done'); assert.equal(r.stopOk, true);
  assert.deepEqual(log.filter(x => x[0] === 'cancel'), [['cancel', 'stop1']]);
  assert.deepEqual(log.find(x => x[0] === 'stop'), ['stop', 0.005, 59000]); assert.equal(p.stopOrderId, 'stop2');
});
