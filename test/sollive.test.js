import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
process.env.MASTER_KEY_B64 = process.env.MASTER_KEY_B64 || crypto.randomBytes(32).toString('base64');
const { newBotWallet, loadBotKeypair, consentMessage, checkConsent, verifySignature, RESERVE_LAMPORTS } = await import('../solwallet.js');
const { getOrder, signOrderTx, SOL_MINT } = await import('../jupiter.js');
const { liveSwap, processLiveItem, solLiveTick, withdrawAll, freshLive, liveCfg, withUserLock, lockCount, retryPendingSells, reconcileLedger, SELL_RETRY } = await import('../sollive.js');
const { normalizeCfg } = await import('../solbot.js');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', MINT2 = 'EGLUyRgBMt35SYzATz5joWydW5f8ebzit9FC7qdopump';
// firma ed25519 real con la clave de un Keypair (como haría Phantom con signMessage)
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const sign = (kp, msg) => crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');

test('wallet del bot: se cifra, se recupera y la clave nunca aparece en claro', () => {
  const rec = newBotWallet(), kp = loadBotKeypair(rec);
  assert.equal(kp.publicKey.toBase58(), rec.pub);
  const b64 = Buffer.from(kp.secretKey).toString('base64');
  assert.ok(!JSON.stringify(rec).includes(b64) && !JSON.stringify(rec).includes(Buffer.from(kp.secretKey.slice(0, 32)).toString('base64')));
  assert.throws(() => loadBotKeypair({ ...rec, pub: Keypair.generate().publicKey.toBase58() }), /integridad/);
  assert.throws(() => loadBotKeypair(null), /no encontrada/);
});

test('autorización: firma válida pasa; otra wallet, mensaje alterado o caducada, no', () => {
  const user = Keypair.generate(), bot = newBotWallet(), wallet = user.publicKey.toBase58(), ts = Date.now();
  const sig = sign(user, consentMessage({ botPub: bot.pub, wallet, ts }));
  assert.equal(checkConsent({ botPub: bot.pub, wallet, ts, signature: sig }).ok, true);
  assert.equal(checkConsent({ botPub: newBotWallet().pub, wallet, ts, signature: sig }).ok, false, 'otra wallet de bot');
  assert.equal(checkConsent({ botPub: bot.pub, wallet: Keypair.generate().publicKey.toBase58(), ts, signature: sig }).ok, false, 'otra wallet de usuario');
  assert.equal(checkConsent({ botPub: bot.pub, wallet, ts: ts + 1, signature: sig }).ok, false, 'timestamp alterado');
  assert.equal(checkConsent({ botPub: bot.pub, wallet, ts: ts - 20 * 60 * 1000, signature: sign(user, consentMessage({ botPub: bot.pub, wallet, ts: ts - 20 * 60 * 1000 })) }).ok, false, 'caducada');
  assert.equal(verifySignature(wallet, 'x', 'no-es-base64'), false); assert.equal(verifySignature('malo', 'x', sig), false);
});

function buildTx(payer, extraSigner) {
  const keys = [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }];
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  if (extraSigner) ix.keys.push({ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false });
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}
test('firma de la transacción de Jupiter: solo si el bot es la única firmante y la pagadora', () => {
  const bot = Keypair.generate(), signed = signOrderTx(buildTx(bot), bot);
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
  const ok = crypto.verify(null, Buffer.from(tx.message.serialize()), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bot.publicKey.toBytes())]), format: 'der', type: 'spki' }), Buffer.from(tx.signatures[0]));
  assert.ok(ok, 'la firma es criptográficamente válida');
  assert.throws(() => signOrderTx(buildTx(Keypair.generate()), bot), /pagadora/);                       // pagadora ajena
  assert.throws(() => signOrderTx(buildTx(bot, Keypair.generate()), bot), /más de una firma/);          // pide otra firma
});

const okOrder = (over = {}) => ({ transaction: 'tx', requestId: 'r1', inAmount: '100000000', outAmount: '1000000000', inputMint: SOL_MINT, outputMint: MINT, ...over });
const fakeFetch = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
test('getOrder valida lo que devuelve Jupiter', async () => {
  const args = { inputMint: SOL_MINT, outputMint: MINT, amount: '100000000', taker: 'T'.repeat(44) };
  assert.equal((await getOrder(args, fakeFetch(200, okOrder()))).requestId, 'r1');
  await assert.rejects(getOrder(args, fakeFetch(200, okOrder({ inAmount: '5' }))), /no coincide/);
  await assert.rejects(getOrder(args, fakeFetch(200, okOrder({ outputMint: MINT2 }))), /otro par/);
  await assert.rejects(getOrder(args, fakeFetch(200, { errorMessage: 'insufficient funds' })), /saldo insuficiente|sin ruta/);
  await assert.rejects(getOrder(args, fakeFetch(400, { error: 'bad' })), /rechazó/);
});

const kpB = Keypair.generate();
const swapDeps = (o = {}) => ({ getOrder: async () => okOrder(o.order), signOrderTx: () => 'signed', execute: async () => o.exec || { status: 'Success', signature: 'S'.repeat(88), totalInputAmount: '100000000', totalOutputAmount: '1000000000' } });
test('liveSwap: no compra si el precio se ha disparado; vender nunca se bloquea por precio', async () => {
  // nuestro precio = 0.1 SOL / 1.0 token = 0.1 ; el del bot origen = 0.05 -> +100%
  const buy = await liveSwap({ kp: kpB, side: 'buy', mint: MINT, amountRaw: '100000000', decimals: 9, refPriceSol: 0.05, deps: swapDeps() });
  assert.equal(buy.status, 'Skipped'); assert.match(buy.error, /price moved/);
  assert.equal((await liveSwap({ kp: kpB, side: 'buy', mint: MINT, amountRaw: '100000000', decimals: 9, refPriceSol: 0.09, deps: swapDeps() })).status, 'Success');
  assert.equal((await liveSwap({ kp: kpB, side: 'sell', mint: MINT, amountRaw: '100000000', decimals: null, refPriceSol: 1e-9, deps: swapDeps() })).status, 'Success');
  assert.equal((await liveSwap({ kp: kpB, side: 'buy', mint: MINT, amountRaw: '1', decimals: 9, refPriceSol: 1, deps: { getOrder: async () => { throw new Error('sin ruta'); } } })).status, 'Failed');
  assert.equal((await liveSwap({ kp: kpB, side: 'buy', mint: MINT, amountRaw: '100000000', decimals: 9, refPriceSol: 0.1, deps: { ...swapDeps(), signOrderTx: () => { throw new Error('pagadora'); } } })).status, 'Failed');
});

const item = (sig, side, extra = {}) => ({ sig, at: 5000, side, mint: MINT, sol: 2, priceSol: 0.1, sellFrac: 1, sym: 'BONK', ...extra });
const mkDeps = (o = {}) => { const calls = [], order = [];
  const deps = { chain: { solLamports: async () => o.lamports ?? 3_000_000_000n, tokenRaw: async () => o.tokens ?? 5_000_000n, decimals: async () => 9 },
    swap: async a => { calls.push(a); order.push('swap'); const r = o.results ? o.results.shift() : { status: 'Success', signature: 'S'.repeat(88), totalInputAmount: a.amountRaw, outAmount: '200000000' }; return r; },
    persist: async () => { order.push('persist'); }, sleep: async () => {} };
  return { deps, calls, order }; };
const cfg = (o = {}) => liveCfg(normalizeCfg({ mode: 'fixed', fixedSol: 0.5, maxPerTradeSol: 1, maxTotalSol: 3, ...o }));

test('compra real: guarda la intención ANTES del swap y registra posición y operación', async () => {
  const live = freshLive(), { deps, calls, order } = mkDeps();
  assert.equal(await processLiveItem({ live, cfg: cfg(), item: item('a', 'buy'), sinceMs: 0, deps }), true);
  assert.deepEqual(order, ['persist', 'swap']);
  assert.equal(calls[0].amountRaw, String(0.5 * 1e9)); assert.equal(calls[0].side, 'buy');
  assert.equal(live.positions[MINT].costSol, 0.5); assert.equal(live.trades[0].type, 'buy'); assert.ok(live.trades[0].sig);
  assert.equal(await processLiveItem({ live, cfg: cfg(), item: item('a', 'buy'), sinceMs: 0, deps }), false, 'misma señal: no se repite'); assert.equal(calls.length, 1);
});
test('compra real: respeta reserva de comisiones, topes y "solo después de autorizar"', async () => {
  let live = freshLive(), { deps, calls } = mkDeps({ lamports: BigInt(RESERVE_LAMPORTS) + 5_000_000n });   // solo 0.005 SOL por encima de la reserva
  await processLiveItem({ live, cfg: cfg(), item: item('a', 'buy'), sinceMs: 0, deps });
  assert.equal(calls.length, 0); assert.equal(live.trades[0].type, 'skip');
  live = freshLive(); ({ deps, calls } = mkDeps());
  assert.equal(await processLiveItem({ live, cfg: cfg(), item: item('b', 'buy', { at: 100 }), sinceMs: 1000 * 1000, deps }), false); assert.equal(calls.length, 0);
  const big = cfg({ fixedSol: 5, maxPerTradeSol: 10, maxTotalSol: 10 }); assert.ok(big.fixedSol <= 1 && big.maxPerTradeSol <= 1 && big.maxTotalSol <= 5, 'topes duros en real');
  assert.equal(await processLiveItem({ live, cfg: cfg({ buys: false }), item: item('c', 'buy'), sinceMs: 0, deps }), true); assert.equal(calls.length, 0);
});
test('venta real: vende la fracción del saldo REAL de la wallet; si falla seguro reintenta; si es incierto no', async () => {
  let live = freshLive(); live.positions[MINT] = { mint: MINT, sym: 'BONK', costSol: 1 };
  let m = mkDeps({ tokens: 1_000_000n }); await processLiveItem({ live, cfg: cfg(), item: item('s1', 'sell', { sellFrac: 0.4 }), sinceMs: 0, deps: m.deps });
  assert.equal(m.calls[0].amountRaw, '400000'); assert.ok(Math.abs(live.positions[MINT].costSol - 0.6) < 1e-9); assert.equal(live.trades[0].type, 'sell');
  m = mkDeps({ results: [{ status: 'Failed', error: 'x' }, { status: 'Failed', error: 'x' }, { status: 'Success', signature: 'S'.repeat(88), outAmount: '300000000' }] });
  await processLiveItem({ live, cfg: cfg(), item: item('s2', 'sell'), sinceMs: 0, deps: m.deps }); assert.equal(m.calls.length, 3); assert.equal(live.positions[MINT], undefined);
  live = freshLive(); m = mkDeps({ results: [{ status: 'Unknown', signature: 'U'.repeat(88) }] });
  await processLiveItem({ live, cfg: cfg(), item: item('s3', 'sell'), sinceMs: 0, deps: m.deps }); assert.equal(m.calls.length, 1, 'incierto: no se repite'); assert.equal(live.trades[0].unknown, true);
  live = freshLive(); m = mkDeps({ tokens: 0n }); await processLiveItem({ live, cfg: cfg(), item: item('s4', 'sell'), sinceMs: 0, deps: m.deps }); assert.equal(m.calls.length, 0, 'sin saldo: nada que vender');
});

function fakeStore(users, wallets) { const kv = { 'solbot:users': users, 'solbot:botwallets': wallets }; return { kv, kvGet: async (k, d) => (kv[k] != null ? kv[k] : d), kvSet: async (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); } }; }
test('ciclo real: desactivado por el operador no hace nada; activado opera con la wallet del bot de cada usuario', async () => {
  const rec = newBotWallet(), store = fakeStore({ u1: { wallet: MINT2, mode: 'live', active: true, since: 0, cfg: { fixedSol: 0.5 } } }, { u1: rec });
  const feed = { items: [item('f1', 'buy')] }, args = { store, fetchFeed: async () => feed, conn: null, minGapMs: 0, gate: { last: 0 } };
  assert.equal((await solLiveTick({ ...args, enabled: () => false })).skipped, 'live-disabled');
  const conn = { getBalance: async () => 3_000_000_000, getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } }), getParsedTokenAccountsByOwner: async () => ({ value: [] }) };
  const r = await solLiveTick({ ...args, conn, enabled: () => true, sleep: async () => {}, swapDeps: swapDeps() });
  assert.equal(r.processed, 1); assert.equal(store.kv['solbot:live:u1'].trades[0].type, 'buy');
  assert.equal((await solLiveTick({ ...args, conn, enabled: () => true, swapDeps: swapDeps() })).processed, 0, 'no repite');
});
test('ciclo real: si el usuario pausa mientras opera, se detiene al momento', async () => {
  const store = fakeStore({ u1: { wallet: MINT2, mode: 'live', active: true, since: 0, cfg: {} } }, { u1: newBotWallet() });
  const conn = { getBalance: async () => 3_000_000_000, getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } }) };
  let n = 0; const deps = swapDeps(); const execOrig = deps.execute; deps.execute = async a => { if (++n === 1) store.kv['solbot:users'].u1.active = false; return execOrig(a); };
  await solLiveTick({ store, fetchFeed: async () => ({ items: [item('p1', 'buy', { at: 5000 }), item('p2', 'buy', { at: 6000 })] }), conn, minGapMs: 0, gate: { last: 0 }, enabled: () => true, swapDeps: deps });
  assert.equal(n, 1, 'la segunda operación no se ejecuta');
});
test('bloqueo por usuario: dos operaciones del mismo usuario no se solapan', async () => {
  const log = []; const a = withUserLock('x', async () => { log.push('a0'); await new Promise(r => setTimeout(r, 30)); log.push('a1'); });
  const b = withUserLock('x', async () => { log.push('b0'); }); await Promise.all([a, b]); assert.deepEqual(log, ['a0', 'a1', 'b0']);
});

test('retirar todo: vende tokens, deja reserva si alguno no se vendió, y envía a la wallet verificada', async () => {
  const sent = []; const kp = Keypair.generate(), to = Keypair.generate().publicKey.toBase58();
  const acct = (mint, amount) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals: 9 } } } } } });
  const conn = { getParsedTokenAccountsByOwner: async () => ({ value: [acct(MINT, '1000'), acct(MINT2, '2000')] }), getBalance: async () => 500_000_000,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }), sendRawTransaction: async raw => { sent.push(raw); return 'T'.repeat(88); }, confirmTransaction: async () => ({ value: { err: null } }) };
  let n = 0; const deps = { ...swapDeps(), getOrder: async a => { if (a.inputMint === MINT2) throw new Error('sin ruta'); return okOrder({ inAmount: a.amount, inputMint: a.inputMint, outputMint: SOL_MINT }); } };
  const r = await withdrawAll({ conn, kp, to, sellAll: true, swapDeps: deps, sleep: async () => {} });
  assert.equal(r.sold.length, 1); assert.equal(r.failed.length, 1); assert.equal(r.lamports, 500_000_000 - 5000 - RESERVE_LAMPORTS, 'deja la reserva por el token no vendido');
  const tx = (await import('@solana/web3.js')).Transaction.from(sent[0]); assert.equal(tx.instructions[0].keys[1].pubkey.toBase58(), to); assert.ok(tx.verifySignatures());
  const r2 = await withdrawAll({ conn: { ...conn, getParsedTokenAccountsByOwner: async () => ({ value: [] }) }, kp, to, sellAll: true, swapDeps: deps });
  assert.equal(r2.lamports, 500_000_000 - 5000, 'sin tokens pendientes se retira todo');
});

// ---- ventas que nunca se pierden ----
const sellItem = (sig, extra = {}) => item(sig, 'sell', extra);
test('venta: si la red falla al leer el saldo, la salida queda PENDIENTE y se reintenta (no se pierde)', async () => {
  const live = freshLive(); live.positions[MINT] = { mint: MINT, sym: 'BONK', costSol: 1 }; let fail = true;
  const m = mkDeps(); m.deps.chain.tokenRaw = async () => { if (fail) throw new Error('429 Too Many Requests'); return 5_000_000n; };
  assert.equal(await processLiveItem({ live, cfg: cfg(), item: sellItem('s1'), sinceMs: 0, deps: m.deps }), true);
  assert.ok(live.pending[MINT], 'quedó pendiente'); assert.equal(m.calls.length, 0); assert.ok(live.done.includes('s1'));
  fail = false; const later = Date.now() + SELL_RETRY.minGapMs + 1;
  assert.equal(await retryPendingSells({ live, deps: m.deps, now: () => later }), true);
  assert.equal(m.calls.length, 1); assert.equal(live.pending[MINT], undefined, 'vendida: ya no está pendiente'); assert.equal(live.positions[MINT], undefined);
});
test('venta: si falla el guardado previo, la salida igualmente queda pendiente en memoria y se completa', async () => {
  const live = freshLive(); const m = mkDeps(); m.deps.persist = async () => { throw new Error('supabase caído'); };
  await assert.rejects(processLiveItem({ live, cfg: cfg(), item: sellItem('s1'), sinceMs: 0, deps: m.deps }), /supabase/);
  assert.ok(live.pending[MINT], 'pendiente aunque no se pudo guardar');
  m.deps.persist = async () => {}; await retryPendingSells({ live, deps: m.deps, now: () => Date.now() + SELL_RETRY.minGapMs + 1 }); assert.equal(m.calls.length, 1);
});
test('venta: tres fallos seguros no la abandonan; reintenta después y, agotados los intentos, avisa', async () => {
  const live = freshLive(); const m = mkDeps({ results: [{ status: 'Failed', error: 'rate' }, { status: 'Failed', error: 'rate' }, { status: 'Failed', error: 'rate' }, { status: 'Success', signature: 'S'.repeat(88), outAmount: '100000000' }] });
  await processLiveItem({ live, cfg: cfg(), item: sellItem('s1'), sinceMs: 0, deps: m.deps });
  assert.equal(m.calls.length, 3); assert.ok(live.pending[MINT], 'sigue pendiente tras 3 fallos');
  const t0 = Date.now(); await retryPendingSells({ live, deps: m.deps, now: () => t0 + 21000 }); assert.equal(live.pending[MINT], undefined, 'el 4º intento (éxito) la resuelve');
  live.pending[MINT] = { sym: 'X', price: 0.1, frac: 1, tries: SELL_RETRY.maxTries, firstAt: t0, lastAt: t0 };
  await retryPendingSells({ live, deps: m.deps, now: () => t0 + 60000 }); assert.equal(live.pending[MINT], undefined); assert.ok(live.trades.some(t => /gave up/.test(t.reason || '')));
});
test('el interruptor general frena operaciones nuevas pero NO las ventas pendientes', async () => {
  const rec = newBotWallet(), store = fakeStore({ u1: { wallet: MINT2, mode: 'live', active: true, since: 0, cfg: {} } }, { u1: rec });
  store.kv['solbot:live:u1'] = { ...freshLive(), pending: { [MINT]: { sym: 'B', price: 0.1, frac: 1, tries: 0, firstAt: Date.now() - 1000, lastAt: 0 } } };
  const conn = { getBalance: async () => 3_000_000_000, getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } }), getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: '5000', decimals: 9 } } } } } }] }) };
  await solLiveTick({ store, fetchFeed: async () => ({ signal: { on: false }, items: [item('b1', 'buy')] }), conn, minGapMs: 0, gate: { last: 0 }, enabled: () => true, swapDeps: swapDeps({ exec: { status: 'Success', signature: 'S'.repeat(88), totalOutputAmount: '1' } }) });
  assert.equal(store.kv['solbot:live:u1'].pending[MINT], undefined, 'la venta pendiente se ejecutó'); assert.ok(!store.kv['solbot:live:u1'].trades.some(t => t.type === 'buy'), 'ninguna compra nueva');
});

// ---- resultado incierto y conciliación ----
test('compra incierta (Unknown): cuenta contra el tope y la conciliación la quita si no hay saldo', async () => {
  const live = freshLive(), m = mkDeps({ results: [{ status: 'Unknown', signature: 'U'.repeat(88) }] });
  await processLiveItem({ live, cfg: cfg(), item: item('b1', 'buy'), sinceMs: 0, deps: m.deps });
  assert.equal(live.positions[MINT].costSol, 0.5, 'se asume ejecutada'); assert.equal(live.trades[0].unknown, true);
  const m2 = mkDeps({ tokens: 0n }); await reconcileLedger(live, m2.deps.chain); assert.equal(live.positions[MINT], undefined, 'sin saldo real, el libro se corrige');
});
test('una venta incierta ya no bloquea el tope total: antes de comprar se concilia con la wallet', async () => {
  const live = freshLive(); live.positions[MINT2] = { mint: MINT2, sym: 'X', costSol: 3 };   // ya llenaba el tope total (3)
  const m = mkDeps({ tokens: 0n });                                                              // pero en la wallet ya no queda nada
  await processLiveItem({ live, cfg: cfg(), item: item('b9', 'buy'), sinceMs: 0, deps: m.deps });
  assert.equal(m.calls.length, 1, 'ahora sí compra'); assert.equal(live.positions[MINT2], undefined);
});

// ---- paralelo, bloqueos y retiro ----
test('usuarios en paralelo: la lentitud de uno no retrasa a los demás', async () => {
  const mk = () => ({ wallet: MINT2, mode: 'live', active: true, since: 0, cfg: {} }), store = fakeStore({ a1: mk(), a2: mk(), a3: mk() }, { a1: newBotWallet(), a2: newBotWallet(), a3: newBotWallet() });
  const conn = { getBalance: async () => 3_000_000_000, getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } }) };
  const d = swapDeps(); const orig = d.execute; d.execute = async a => { await new Promise(r => setTimeout(r, 80)); return orig(a); };
  const t0 = Date.now(); const r = await solLiveTick({ store, fetchFeed: async () => ({ items: [item('p1', 'buy')] }), conn, minGapMs: 0, gate: { last: 0 }, enabled: () => true, swapDeps: d });
  assert.equal(r.processed, 3); assert.ok(Date.now() - t0 < 200, 'en serie serían ~240 ms: ' + (Date.now() - t0));
});
test('el mapa de bloqueos no crece: se limpia al terminar', async () => {
  await Promise.all(['k1', 'k2', 'k3'].map(u => withUserLock(u, async () => {}))); await new Promise(r => setTimeout(r, 5)); assert.equal(lockCount(), 0);
});
test('retirar SOL sin vender: si quedan tokens, deja la reserva para poder venderlos después', async () => {
  const kp = Keypair.generate(), to = Keypair.generate().publicKey.toBase58();
  const acct = { account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: '1000', decimals: 9 } } } } } };
  const mkConn = value => ({ getParsedTokenAccountsByOwner: async () => ({ value }), getBalance: async () => 500_000_000, getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }), sendRawTransaction: async () => 'T'.repeat(88), confirmTransaction: async () => ({ value: { err: null } }) });
  const r = await withdrawAll({ conn: mkConn([acct]), kp, to, sellAll: false });
  assert.equal(r.lamports, 500_000_000 - 5000 - RESERVE_LAMPORTS); assert.equal(r.keptReserve, true);
  assert.equal((await withdrawAll({ conn: mkConn([]), kp, to, sellAll: false })).lamports, 500_000_000 - 5000, 'sin tokens se retira todo');
});
