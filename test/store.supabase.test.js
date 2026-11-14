import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://sb.example.test'; process.env.SUPABASE_SERVICE_KEY = 'fake-test-key';
const { store } = await import('../store.js');
const realFetch = globalThis.fetch;
const mock = fn => { globalThis.fetch = fn; };
test.afterEach(() => { globalThis.fetch = realFetch; });
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const DEFAULT_STATE = { lastSignalId: null, positions: {} };

test('supabase: respuesta HTTP no-2xx LANZA (antes devolvía estado vacío y el siguiente guardado borraba todo)', async () => {
  for (const status of [401, 500, 503]) {
    mock(async () => json(status, { message: 'boom' }));
    await assert.rejects(() => store.state(), /HTTP/, 'state ' + status);
    await assert.rejects(() => store.clients(), /HTTP/, 'clients ' + status);
    await assert.rejects(() => store.strategyState(), /HTTP/, 'strategy ' + status);
  }
});

test('supabase: error de red LANZA', async () => {
  mock(async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(() => store.state(), /ECONNRESET|leer/);
});

test('supabase: JSON ilegible LANZA', async () => {
  mock(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }));
  await assert.rejects(() => store.state());
});

test('supabase: fila inexistente (200 con lista vacía) devuelve el valor por defecto', async () => {
  mock(async () => json(200, []));
  assert.deepEqual(await store.state(), DEFAULT_STATE);
  assert.deepEqual(await store.clients(), []);
  assert.equal(await store.strategyState(), null);
});

test('supabase: fila existente se devuelve tal cual', async () => {
  mock(async () => json(200, [{ v: { lastSignalId: 's1', positions: { u1: [] } } }]));
  assert.equal((await store.state()).lastSignalId, 's1');
});

test('el mensaje de error no incluye la clave de servicio ni la URL con ella', async () => {
  mock(async () => json(500, {}));
  await assert.rejects(() => store.state(), e => !String(e.message).includes('fake-test-key'));
});
