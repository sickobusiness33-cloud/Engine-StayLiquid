import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
process.env.MASTER_KEY_B64 = process.env.MASTER_KEY_B64 || crypto.randomBytes(32).toString('base64');
const { makeSolApi } = await import('../solapi.js');
const { consentMessage, loadBotKeypair } = await import('../solwallet.js');

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const sign = (kp, msg) => crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');
const mkStore = () => { const kv = {}; return { kv, kvGet: async (k, d) => (kv[k] != null ? JSON.parse(JSON.stringify(kv[k])) : d), kvSet: async (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); } }; };
const conn = bal => ({ getBalance: async () => bal, getParsedTokenAccountsByOwner: async () => ({ value: [] }), getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }), sendRawTransaction: async () => 'T'.repeat(88), confirmTransaction: async () => ({ value: { err: null } }) });
const q = o => new URLSearchParams(o);
const UID = 'user-aaaaaa', user = Keypair.generate(), W = user.publicKey.toBase58();

async function setup(over = {}) {
  const store = mkStore(), api = makeSolApi({ store, getConnection: () => conn(over.bal ?? 500_000_000), now: over.now });
  const w = await api.post('/api/solbot/wallet', { uid: UID });
  return { store, api, pub: w.body.pub, w };
}
async function liveConnect(api, pub, extra = {}, signer = user, wallet = W) {
  const c = await api.get('/api/solbot/consent', q({ uid: UID, wallet })); assert.equal(c.code, 200);
  return api.post('/api/solbot/connect', { uid: UID, wallet, mode: 'live', ts: c.body.ts, signature: sign(signer, c.body.message), cfg: { fixedSol: 3, maxPerTradeSol: 9, maxTotalSol: 99 }, ...extra });
}

test('wallet del bot: se crea una vez, se reutiliza y la respuesta nunca contiene la clave', async () => {
  const { store, api, pub, w } = await setup();
  assert.equal(w.code, 200); assert.equal(w.body.exists, true); assert.ok(pub && pub.length >= 32);
  assert.equal((await api.post('/api/solbot/wallet', { uid: UID })).body.pub, pub, 'misma wallet');
  const secret = Buffer.from(loadBotKeypair(store.kv['solbot:botwallets'][UID]).secretKey).toString('base64');
  assert.ok(!JSON.stringify(w.body).includes(secret) && !JSON.stringify(store.kv).includes(secret), 'la clave no aparece en claro ni en el estado');
  assert.equal((await api.get('/api/solbot/wallet', q({ uid: 'otro-uid-1' }))).body.exists, false);
});

test('conectar en real exige una autorización firmada válida y aplica topes duros', async () => {
  const { api, pub } = await setup(); const t = Date.now();
  assert.equal((await api.post('/api/solbot/connect', { uid: UID, wallet: W, mode: 'live', ts: t, signature: 'x', cfg: {} })).code, 400, 'sin firma válida');
  assert.equal((await liveConnect(api, pub, {}, Keypair.generate())).code, 400, 'firmada por otra wallet');
  const stale = Date.now() - 20 * 60 * 1000; assert.equal((await api.post('/api/solbot/connect', { uid: UID, wallet: W, mode: 'live', ts: stale, signature: sign(user, consentMessage({ botPub: pub, wallet: W, ts: stale })), cfg: {} })).code, 400, 'caducada');
  const ok = await liveConnect(api, pub);
  assert.equal(ok.code, 200); assert.equal(ok.body.mode, 'live'); assert.equal(ok.body.botWallet, pub); assert.equal(ok.body.active, true);
  assert.ok(ok.body.cfg.fixedSol <= 1 && ok.body.cfg.maxPerTradeSol <= 1 && ok.body.cfg.maxTotalSol <= 5, 'topes: ' + JSON.stringify(ok.body.cfg));
  assert.equal(ok.body.balanceSol, 0.5);
});
test('sin wallet de bot creada no se puede autorizar; una wallet no puede estar en dos cuentas', async () => {
  const store = mkStore(), api = makeSolApi({ store, getConnection: () => conn(0) });
  assert.equal((await api.get('/api/solbot/consent', q({ uid: UID, wallet: W }))).code, 409);
  const { api: api2, pub } = await setup(); await liveConnect(api2, pub);
  await api2.post('/api/solbot/wallet', { uid: 'user-bbbbbb' });
  const c = await api2.get('/api/solbot/consent', q({ uid: 'user-bbbbbb', wallet: W }));
  assert.equal((await api2.post('/api/solbot/connect', { uid: 'user-bbbbbb', wallet: W, mode: 'live', ts: c.body.ts, signature: sign(user, c.body.message), cfg: {} })).code, 409);
});
test('pausar y reanudar: al reanudar solo se copia lo posterior', async () => {
  let t = 1_000_000; const { api, pub, store } = await setup({ now: () => t }); await liveConnect(api, pub);
  assert.equal((await api.post('/api/solbot/config', { uid: UID, active: false })).body.active, false);
  t = 5_000_000; const r = await api.post('/api/solbot/config', { uid: UID, active: true }); assert.equal(r.body.active, true); assert.equal(store.kv['solbot:users'][UID].since, 5_000_000);
});
test('retirar: pausa el bot y envía SIEMPRE a la wallet verificada, aunque la petición traiga otro destino', async () => {
  const { api, pub, store } = await setup(); await liveConnect(api, pub);
  const attacker = Keypair.generate().publicKey.toBase58();
  const r = await api.post('/api/solbot/withdraw', { uid: UID, sellAll: true, to: attacker, wallet: attacker });
  assert.equal(r.code, 200); assert.equal(r.body.to, W, 'el destino lo fija el servidor'); assert.ok(r.body.signature); assert.equal(r.body.lamports, 500_000_000 - 5000);
  assert.equal(store.kv['solbot:users'][UID].active, false, 'el bot queda pausado');
  assert.equal((await api.post('/api/solbot/withdraw', { uid: 'user-zzzzzz' })).code, 404);
});
test('retirar con la red caída: error claro, sin filtrar URLs, y los fondos siguen en la wallet', async () => {
  const store = mkStore(), bad = { ...conn(1), getBalance: async () => { throw new Error('fetch https://rpc.example.com/?api-key=SECRETKEY1234567890SECRETKEY1234567890 failed'); } };
  const api = makeSolApi({ store, getConnection: () => bad }); await api.post('/api/solbot/wallet', { uid: UID });
  const wallets = store.kv['solbot:botwallets']; wallets[UID].payoutWallet = W; await store.kvSet('solbot:botwallets', wallets);
  const r = await api.post('/api/solbot/withdraw', { uid: UID }); assert.equal(r.code, 502); assert.ok(!JSON.stringify(r.body).includes('SECRETKEY') && !JSON.stringify(r.body).includes('rpc.example'), JSON.stringify(r.body));
});
test('desconectar en real NO borra la wallet del bot ni su historial: se pueden retirar los fondos después', async () => {
  const { api, pub, store } = await setup(); await liveConnect(api, pub);
  const d = await api.post('/api/solbot/disconnect', { uid: UID }); assert.equal(d.code, 200); assert.equal(d.body.keptBotWallet, true);
  assert.equal((await api.get('/api/solbot/status', q({ uid: UID }))).code, 404); assert.equal(store.kv['solbot:botwallets'][UID].pub, pub);
  assert.equal((await api.post('/api/solbot/withdraw', { uid: UID })).body.to, W, 'destino recordado (wallet de cobro)');
});
test('uid hostil (__proto__) no resuelve al prototipo', async () => {
  const { api } = await setup();
  assert.equal((await api.get('/api/solbot/status', q({ uid: '__proto__' }))).code, 404);
  assert.equal((await api.post('/api/solbot/config', { uid: '__proto__', active: true })).code, 404);
  assert.equal(({}).active, undefined);
});

test('sesión robada: cambiar de wallet NO desvía los fondos hasta pasadas 24 h, y volver a la de siempre cancela el cambio', async () => {
  let t = Date.now(); const { api, pub, store } = await setup({ now: () => t }); await liveConnect(api, pub);
  assert.equal(store.kv['solbot:botwallets'][UID].payoutWallet, W, 'la primera wallet queda como cobro');
  const attacker = Keypair.generate(), A = attacker.publicKey.toBase58();
  const c = await api.get('/api/solbot/consent', q({ uid: UID, wallet: A })); // el atacante vincula su wallet y firma con ella
  const hijack = await api.post('/api/solbot/connect', { uid: UID, wallet: A, mode: 'live', ts: c.body.ts, signature: sign(attacker, c.body.message), cfg: {} });
  assert.equal(hijack.code, 200); assert.equal(hijack.body.payoutWallet, W); assert.equal(hijack.body.pendingPayout.wallet, A);
  assert.equal((await api.post('/api/solbot/withdraw', { uid: UID, sellAll: true })).body.to, W, 'el retiro sigue yendo al dueño');
  t += 25 * 60 * 60 * 1000;                                           // el dueño tuvo 24 h para darse cuenta
  assert.equal((await api.post('/api/solbot/withdraw', { uid: UID })).body.to, A, 'pasado el plazo el cambio se aplica');
});
test('volver a conectar la wallet de cobro original cancela el cambio pendiente', async () => {
  const { api, pub, store } = await setup(); await liveConnect(api, pub);
  const other = Keypair.generate(); await liveConnect(api, pub, {}, other, other.publicKey.toBase58());
  assert.ok(store.kv['solbot:botwallets'][UID].pendingPayout); await liveConnect(api, pub);
  assert.equal(store.kv['solbot:botwallets'][UID].pendingPayout, undefined);
});
