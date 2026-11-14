import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-store-'));
process.env.DATA_DIR = dir;
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const { store } = await import('../store.js');
const f = n => path.join(dir, n);

test('archivos: si no existen (primer arranque) devuelve los valores por defecto', async () => {
  assert.deepEqual(await store.clients(), []);
  assert.deepEqual(await store.state(), { lastSignalId: null, positions: {} });
  assert.equal(await store.strategyState(), null);
});

test('archivos: un state.json corrupto LANZA y no se toca (no se confunde con "sin posiciones")', async () => {
  fs.writeFileSync(f('state.json'), '{"positions": {"u1": [ {"symbol":"BTC/USDT"');   // JSON cortado
  await assert.rejects(() => store.state(), /state\.json/);
  assert.equal(fs.readFileSync(f('state.json'), 'utf8').includes('BTC/USDT'), true, 'el archivo sigue intacto');
});

test('archivos: clients.json y strategy.json corruptos también lanzan', async () => {
  fs.writeFileSync(f('clients.json'), 'no es json'); fs.writeFileSync(f('strategy.json'), '{');
  await assert.rejects(() => store.clients(), /clients\.json/);
  await assert.rejects(() => store.strategyState(), /strategy\.json/);
});

test('archivos: un archivo válido se lee normalmente', async () => {
  fs.writeFileSync(f('state.json'), JSON.stringify({ lastSignalId: 's9', positions: { u1: [{ symbol: 'BTC/USDT' }] } }));
  const st = await store.state();
  assert.equal(st.lastSignalId, 's9'); assert.equal(st.positions.u1.length, 1);
});
