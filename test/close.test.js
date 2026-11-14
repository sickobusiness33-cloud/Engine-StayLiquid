import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOrderId, planClose, shouldRetryClose, closeExhausted, markCloseFailed, closePosition, safeErr } from '../close.js';
import { reduceOrderId, executeReduce, shouldRetry, RETRY } from '../partial.js';

const rules = { min: 0.001, round: x => Math.floor(x * 1000 + 1e-9) / 1000 };

// Exchange simulado: registra cada llamada en `log` para comprobar el ORDEN de las operaciones.
function fakeLive({ failWith = null, rule = rules, rulesError = null, cancelError = null } = {}) {
  const log = [];
  const client = {
    cancelOrder: async id => { log.push(['cancel', id]); if (cancelError) throw cancelError; },
  };
  const ex = {
    amountRules: async () => { if (rulesError) throw rulesError; return rule; },
    placeOrder: async (c, o) => { log.push(['order', o]); if (failWith) throw failWith; return { id: 'o1' }; },
  };
  return { live: { ex, client }, log };
}
const pos = (extra = {}) => ({ clientOrderId: 'u1-sig7', posId: 'p1-2', symbol: 'BTC/USDT', side: 'long', amount: 0.01, amountUsd: 1000, ...extra });
const depsOf = (live, persist = async () => {}, now) => ({ mode: live ? 'live' : 'paper', live, persist, ...(now ? { now } : {}) });

test('closeOrderId: determinista, único por posición (aunque se reabra el símbolo), <=36 y distinto del de reduce', () => {
  const a = closeOrderId('u1', pos()), b = closeOrderId('u1', pos());
  assert.equal(a, b);
  assert.notEqual(a, closeOrderId('u2', pos()), 'otro cliente');
  assert.notEqual(a, closeOrderId('u1', pos({ clientOrderId: 'u1-sig9' })), 'misma posId/símbolo pero otra apertura');
  const sinPosId = { clientOrderId: 'u1-sig1', symbol: 'BTC/USDT' }, otra = { clientOrderId: 'u1-sig2', symbol: 'BTC/USDT' };
  assert.notEqual(closeOrderId('u1', sinPosId), closeOrderId('u1', otra), 'sin posId, reabrir BTC no hereda el id viejo');
  assert.ok(a.length <= 36); assert.match(a, /^[a-z0-9]+$/);
  assert.notEqual(a, reduceOrderId('u1', 'p1-2'));
});

test('planClose: redondea a la precisión, informa del residuo y detecta polvo', () => {
  assert.deepEqual(planClose(0.01, rules), { ok: true, qty: 0.01, residual: 0 });
  const r = planClose(0.0107, rules);
  assert.equal(r.ok, true); assert.equal(r.qty, 0.01); assert.ok(Math.abs(r.residual - 0.0007) < 1e-12);
  assert.equal(planClose(0.0005, rules).reason, 'rounds_to_zero');
  assert.equal(planClose(0.0015, { min: 0.002, round: rules.round }).reason, 'below_min');
  assert.equal(planClose(0, rules).reason, 'no_amount');
  assert.deepEqual(planClose(0.5), { ok: true, qty: 0.5, residual: 0 }, 'paper: sin reglas, cantidad tal cual');
});

test('paper: cierra sin tocar ningún exchange y la posición sale de la lista', async () => {
  const p = pos(), other = pos({ clientOrderId: 'u1-sig8', posId: 'p9' });
  const { list, result } = await closePosition({ list: [p, other], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(null) });
  assert.equal(result.status, 'done'); assert.deepEqual(list, [other], 'solo se quita la posición cerrada');
});

test('live OK: intención guardada ANTES de enviar, orden reduceOnly con cantidad redonda y stop cancelado DESPUÉS', async () => {
  const { live, log } = fakeLive(); const p = pos({ amount: 0.0107, stopOrderId: 'stop1', stop: 59000 });
  const persist = async () => log.push(['persist', p.closePending && p.closePending.orderId]);
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live, persist) });
  assert.equal(result.status, 'done'); assert.equal(result.stopCancelled, true); assert.equal(list.length, 0);
  assert.deepEqual(log.map(x => x[0]), ['persist', 'order', 'cancel'], 'orden: guardar -> enviar -> cancelar stop');
  assert.equal(log[0][1], closeOrderId('u1', p), 'la intención ya llevaba el id');
  const o = log[1][1];
  assert.equal(o.amount, 0.01); assert.equal(o.side, 'sell'); assert.equal(o.type, 'market');
  assert.equal(o.params.reduceOnly, true); assert.equal(o.clientOrderId, closeOrderId('u1', p));
  assert.ok(Math.abs(result.residual - 0.0007) < 1e-12);
});

test('live short: el cierre es una compra reduceOnly', async () => {
  const { live, log } = fakeLive(); const p = pos({ side: 'short' });
  await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(log.find(x => x[0] === 'order')[1].side, 'buy');
});

test('live FALLO: la posición se queda en el estado, el stop NO se cancela y se programa reintento', async () => {
  const { live, log } = fakeLive({ failWith: new Error('Insufficient margin') }); const p = pos({ stopOrderId: 'stop1' });
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live, async () => {}, () => 1000) });
  assert.equal(result.status, 'failed'); assert.match(result.error, /Insufficient margin/);
  assert.deepEqual(list, [p], 'sigue controlada por el motor');
  assert.equal(p.amount, 0.01); assert.equal(p.stopOrderId, 'stop1');
  assert.ok(!log.some(x => x[0] === 'cancel'), 'el stop sigue protegiendo');
  assert.equal(p.closePending.tries, 1); assert.equal(p.closePending.signalId, 's');
});

test('live: un reintento tras el fallo cierra, cancela el stop y limpia el estado pendiente', async () => {
  const bad = fakeLive({ failWith: new Error('timeout') }); const p = pos({ stopOrderId: 'stop1' });
  let r = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(bad.live, async () => {}, () => 1000) });
  assert.equal(r.list.length, 1);
  const ok = fakeLive();
  r = await closePosition({ list: r.list, p, uid: 'u1', symbol: 'BTC/USDT', signalId: 'retry', deps: depsOf(ok.live, async () => {}, () => 7000) });
  assert.equal(r.result.status, 'done'); assert.equal(r.list.length, 0);
  assert.deepEqual(ok.log.filter(x => x[0] === 'cancel'), [['cancel', 'stop1']]);
});

test('reintentos acotados: máx. 3 intentos en 2 minutos y la posición NO se abandona', async () => {
  const t0 = 1_000_000; const p = pos();
  assert.equal(shouldRetryClose(p, t0), false, 'sin cierre pendiente no hay reintento');
  const { live } = fakeLive({ failWith: new Error('rate limit') });
  let now = t0; const deps = depsOf(live, async () => {}, () => now);
  let list = [p];
  for (let i = 1; i <= RETRY.maxTries; i++) {
    ({ list } = await closePosition({ list, p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps }));
    assert.equal(p.closePending.tries, i);
    now += RETRY.minGapMs;
  }
  assert.equal(shouldRetryClose(p, now), false, '3 intentos agotados');
  assert.deepEqual(list, [p], 'agotados los reintentos, sigue en el estado (y con su stop)');
  const q = pos({ closePending: { tries: 1, firstAt: t0, lastAt: t0 } });
  assert.equal(shouldRetryClose(q, t0 + 1000), false, 'demasiado pronto');
  assert.equal(shouldRetryClose(q, t0 + RETRY.minGapMs), true);
  assert.equal(shouldRetryClose(q, t0 + RETRY.windowMs + 1), false, 'fuera de ventana');
});

test('live DUPLICADO: se da por hecho (sin vender dos veces) y se quita la posición', async () => {
  const dup = Object.assign(new Error('Duplicate order sent.'), { name: 'DuplicateOrderId' });
  const { live, log } = fakeLive({ failWith: dup }); const p = pos({ stopOrderId: 'stop1' });
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(result.status, 'done'); assert.equal(result.via, 'duplicate'); assert.equal(list.length, 0);
  assert.equal(log.filter(x => x[0] === 'order').length, 1, 'un solo envío');
  assert.deepEqual(log.filter(x => x[0] === 'cancel'), [['cancel', 'stop1']]);
});

test('recuperación tras caída: intención guardada sin resultado -> se reenvía con el MISMO id y el duplicado cuenta como hecho', async () => {
  const t0 = 1_000_000;
  const p = pos({ closePending: { tries: 0, firstAt: t0, lastAt: t0, signalId: 's', orderId: closeOrderId('u1', pos()) } });
  assert.equal(shouldRetryClose(p, t0 + RETRY.minGapMs), true);
  const { live, log } = fakeLive({ failWith: new Error('Duplicate order sent.') });
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 'retry', deps: depsOf(live) });
  assert.equal(result.status, 'done'); assert.equal(list.length, 0);
  assert.equal(log.find(x => x[0] === 'order')[1].clientOrderId, closeOrderId('u1', pos()));
});

test('caída larga del motor: la intención sin resolver se reintenta aunque haya pasado la ventana, con presupuesto nuevo', async () => {
  const t0 = 1_000_000;
  const p = pos({ closePending: { tries: 0, firstAt: t0, lastAt: t0 } });
  assert.equal(shouldRetryClose(p, t0 + 3_600_000), true);
  const { live } = fakeLive({ failWith: new Error('timeout') });
  const now = t0 + 3_600_000;
  await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 'retry', deps: depsOf(live, async () => {}, () => now) });
  assert.equal(p.closePending.tries, 1); assert.equal(p.closePending.firstAt, now, 'la ventana de 2 min se cuenta desde este intento');
  assert.equal(closeExhausted(p, now), false);
});

test('si no se puede guardar la intención, NO se envía la orden', async () => {
  const { live, log } = fakeLive(); const p = pos();
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live, async () => { throw new Error('disk full'); }) });
  assert.equal(result.status, 'failed'); assert.match(result.error, /persist: disk full/);
  assert.ok(!log.some(x => x[0] === 'order')); assert.equal(list.length, 1);
});

test('markCloseFailed (cliente de exchange no disponible) cuenta el intento y closeExhausted lo detecta', () => {
  const p = pos(); let now = 1_000_000;
  for (let i = 0; i < RETRY.maxTries; i++) { markCloseFailed(p, 's', new Error('clave rechazada'), () => now); now += RETRY.minGapMs; }
  assert.equal(p.closePending.tries, RETRY.maxTries); assert.equal(closeExhausted(p, now), true); assert.equal(shouldRetryClose(p, now), false);
});

test('bajo el mínimo (polvo): no envía orden, se libera la posición con motivo explícito', async () => {
  const { live, log } = fakeLive({ rule: { min: 0.002, round: rules.round } }); const p = pos({ amount: 0.0015, stopOrderId: 'stop1' });
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(result.status, 'dust'); assert.equal(result.reason, 'below_min'); assert.equal(result.amount, 0.0015);
  assert.ok(!log.some(x => x[0] === 'order'), 'el exchange rechazaría la orden: no se envía');
  assert.equal(list.length, 0, 'se libera para no reintentar eternamente');
  assert.deepEqual(log.filter(x => x[0] === 'cancel'), [['cancel', 'stop1']], 'se limpia el stop huérfano');
});

test('si no se pueden leer las reglas del par, falla y reintenta (no cierra a ciegas)', async () => {
  const { live, log } = fakeLive({ rulesError: new Error('markets unavailable') }); const p = pos();
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(result.status, 'failed'); assert.match(result.error, /rules: markets unavailable/);
  assert.equal(list.length, 1); assert.ok(!log.some(x => x[0] === 'order'));
});

test('cierre confirmado pero el cancelar-stop falla: la posición sale y se avisa del stop huérfano', async () => {
  const { live } = fakeLive({ cancelError: new Error('network down') }); const p = pos({ stopOrderId: 'stop1' });
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(result.status, 'done'); assert.equal(list.length, 0);
  assert.equal(result.stopCancelled, false); assert.match(result.stopError, /network down/); assert.equal(result.stopOrderId, 'stop1');
});

test('cancelar un stop que ya no existe (OrderNotFound) no es un problema', async () => {
  const nf = Object.assign(new Error('Unknown order sent.'), { name: 'OrderNotFound' });
  const { live } = fakeLive({ cancelError: nf }); const p = pos({ stopOrderId: 'stop1' });
  const { result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(result.status, 'done'); assert.equal(result.stopCancelled, true);
});

test('el motivo del error se acota (sin volcar respuestas enormes al log)', async () => {
  const { live } = fakeLive({ failWith: new Error('x'.repeat(5000)) }); const p = pos();
  const { result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.equal(result.status, 'failed'); assert.ok(result.error.length <= 300);
});

test('un corte parcial no compite con un cierre en curso', async () => {
  const p = pos({ closePending: { tries: 1, firstAt: 1_000_000, lastAt: 1_000_000 }, reducePending: { frac: 0.5, tries: 1, firstAt: 1_000_000, lastAt: 1_000_000 } });
  assert.equal(shouldRetry(p, 1_000_000 + RETRY.minGapMs), false);
  const { live, log } = fakeLive();
  const r = await executeReduce({ p, uid: 'u1', symbol: 'BTC/USDT', frac: 0.5, deps: { mode: 'live', live, persist: async () => {} } });
  assert.equal(r.status, 'noop'); assert.ok(!log.some(x => x[0] === 'order'));
});

test('cantidad guardada inválida (0/NaN): NO se libera como polvo, falla y queda visible', async () => {
  for (const bad of [0, NaN, undefined]) {
    const { live, log } = fakeLive(); const p = pos({ amount: bad, stopOrderId: 'stop1' });
    const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
    assert.equal(result.status, 'failed'); assert.match(result.error, /invalid_amount/);
    assert.equal(list.length, 1); assert.ok(log.length === 0, 'ni orden ni cancelación de stop');
  }
});

test('modo live sin cliente de exchange: falla (no simula un cierre en paper)', async () => {
  const p = pos();
  const { list, result } = await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: { mode: 'live', live: null, persist: async () => {} } });
  assert.equal(result.status, 'failed'); assert.equal(list.length, 1);
});

test('safeErr: redacta claves/firmas y acota la longitud', () => {
  const e = new Error('binance GET https://x/api?symbol=BTC&signature=abcdef123456&timestamp=1 {"apiKey":"AKIA123","secret":"s3cr3t"} password=hunter2');
  const m = safeErr(e);
  for (const leak of ['abcdef123456', 'AKIA123', 's3cr3t', 'hunter2']) assert.ok(!m.includes(leak), 'filtra ' + leak);
  assert.match(m, /\[redacted\]/); assert.ok(safeErr(new Error('x'.repeat(9999))).length <= 300);
});

test('cancelar stop: "symbol not found" NO cuenta como stop ya inexistente; "Unknown order" sí', async () => {
  const mk = async msg => { const { live } = fakeLive({ cancelError: new Error(msg) }); const p = pos({ stopOrderId: 'stop1' }); return (await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) })).result; };
  assert.equal((await mk('binance {"msg":"symbol not found"}')).stopCancelled, false);
  assert.equal((await mk('API key not found')).stopCancelled, false);
  assert.equal((await mk('Unknown order sent.')).stopCancelled, true);
  assert.equal((await mk('Order does not exist.')).stopCancelled, true);
});

test('el último error queda en el estado de la posición (closePending.lastError), acotado y sin secretos', async () => {
  const { live } = fakeLive({ failWith: new Error('boom secret=topsecret') }); const p = pos();
  await closePosition({ list: [p], p, uid: 'u1', symbol: 'BTC/USDT', signalId: 's', deps: depsOf(live) });
  assert.match(p.closePending.lastError, /boom/); assert.ok(!p.closePending.lastError.includes('topsecret'));
});
