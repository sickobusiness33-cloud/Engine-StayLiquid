import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileClient } from '../reconcile.js';

// Exchange simulado: openPositions devuelve lo que se le indique (array, o null = "no se sabe").
const mkEx = real => ({ openPositions: async () => real });
const client = { fetchTicker: async () => ({ last: 60000 }) };
const pos = (extra = {}) => ({ clientOrderId: 'u1-s1', symbol: 'BTC/USDT', side: 'long', entry: 60000, amount: 0.01, stop: 59000, stopOrderId: 'st', peak: 60000, armed: false, ...extra });
const run = (positions, real) => reconcileClient({ mode: 'live', ex: mkEx(real), client, uid: 'u1', positions, lastPrice: 60000, symbol: positions[0].symbol, log: () => {} });

test('si el exchange no puede responder (null: error o sin fetchPositions) NO se borra ninguna posición', async () => {
  const kept = await run([pos(), pos({ closePending: { tries: 3, firstAt: 1, lastAt: 1 } })], null);
  assert.equal(kept.length, 2, 'ni la normal ni la que tiene un cierre pendiente');
});

test('si el exchange confirma que no hay nada abierto, se quitan solo las posiciones de ESE símbolo', async () => {
  const eth = pos({ symbol: 'ETH/USDT', clientOrderId: 'u1-s2' });
  const kept = await run([pos(), eth], []);
  assert.deepEqual(kept, [eth]);
});

test('si el exchange confirma posición abierta, se mantienen (también con cierre pendiente)', async () => {
  const kept = await run([pos({ closePending: { tries: 1, firstAt: 1, lastAt: 1 } })], [{ contracts: 0.01 }]);
  assert.equal(kept.length, 1);
});
