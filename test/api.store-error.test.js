import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-api-'));
process.env.DATA_DIR = dir; process.env.PORT = '0';
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const { startApi } = await import('../api.js');
const server = startApi(0);
await new Promise(r => server.listening ? r() : server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('API: si el almacenamiento está corrupto responde 503 y el servidor SIGUE vivo (no se cae)', async () => {
  fs.writeFileSync(path.join(dir, 'clients.json'), 'corrupto');
  for (let i = 0; i < 2; i++) {
    const r = await fetch(base + '/api/bot/health');
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /almacenamiento no disponible/);
  }
});

test('API: con el almacenamiento sano vuelve a responder 200', async () => {
  fs.writeFileSync(path.join(dir, 'clients.json'), '[]');
  const r = await fetch(base + '/api/bot/health');
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
});

test('API: una ruta desconocida sigue dando 404', async () => {
  assert.equal((await fetch(base + '/nada')).status, 404);
});
