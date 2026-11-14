// ============================================================================
// SOLLIVE · Copy Bot de Solana con dinero REAL (24/7, con el navegador cerrado)
// ----------------------------------------------------------------------------
// Por cada usuario 'live' activo, copia cada operación NUEVA del bot StayLiquid desde SU wallet de bot, vía Jupiter.
// Protecciones: interruptor del operador (SOLBOT_LIVE=on), reserva para comisiones, topes por operación/total, compra rechazada
// si el precio se ha disparado frente al del bot origen, intención guardada ANTES de mover dinero (nada se repite tras una caída),
// una operación por usuario a la vez, solo operaciones posteriores a la autorización, y VENTAS que nunca se pierden: si fallan
// (red, Jupiter) quedan pendientes y se reintentan hasta salir.
// ============================================================================
import { SOL_MINT, getOrder as jupOrder, signOrderTx, execute as jupExecute } from './jupiter.js';
import { isAddr, copySize, num, clamp, toMs, note, normalizeCfg } from './solbot.js';
import { scrub, RESERVE_LAMPORTS, TRANSFER_FEE_LAMPORTS, loadBotKeypair, getConn, solBalance, tokenBalance, mintDecimals, allTokens, transferSol } from './solwallet.js';

export const liveEnabled = () => (process.env.SOLBOT_LIVE || '').toLowerCase() === 'on';
export const LIVE_LIMITS = { fixedSol: 1, maxPerTradeSol: 1, maxTotalSol: 5 };   // topes duros en real (los ajustes del usuario nunca los superan)
export const SELL_RETRY = { maxTries: 12, minGapMs: 20000, windowMs: 30 * 60 * 1000 };
export const CONCURRENCY = 5;
export const freshLive = () => ({ done: [], positions: {}, trades: [], pending: {} });
export const liveCfg = raw => { const cfg = normalizeCfg(raw); return { ...cfg, fixedSol: Math.min(cfg.fixedSol, LIVE_LIMITS.fixedSol), maxPerTradeSol: Math.min(cfg.maxPerTradeSol, LIVE_LIMITS.maxPerTradeSol), maxTotalSol: Math.min(cfg.maxTotalSol, LIVE_LIMITS.maxTotalSol) }; };
const sleepReal = ms => new Promise(r => setTimeout(r, ms));

// Una operación por usuario a la vez (el ciclo y el retiro no se pisan). La entrada se borra al terminar.
const locks = new Map();
export const lockCount = () => locks.size;
export const withUserLock = (uid, fn) => {
  const prev = locks.get(uid) || Promise.resolve(), r = prev.then(fn, fn), tail = r.then(() => {}, () => {});
  locks.set(uid, tail); tail.then(() => { if (locks.get(uid) === tail) locks.delete(uid); });
  return r;
};

// ---------- swap real ----------
// Devuelve { status: 'Success'|'Failed'|'Unknown'|'Skipped', signature?, error?, totalInputAmount?, outAmount? }.
export async function liveSwap({ kp, side, mint, amountRaw, decimals, refPriceSol, deps = {}, maxDev = Number(process.env.SOLBOT_MAX_PRICE_DEV) || 0.25 }) {
  const d = { getOrder: jupOrder, signOrderTx, execute: jupExecute, ...deps };
  const inputMint = side === 'buy' ? SOL_MINT : mint, outputMint = side === 'buy' ? mint : SOL_MINT;
  const referral = process.env.JUP_REFERRAL_ACCOUNT || null, feeBps = Number(process.env.SOLBOT_FEE_BPS || 110);
  let order;
  try { order = await d.getOrder({ inputMint, outputMint, amount: amountRaw, taker: kp.publicKey.toBase58(), feeBps, referral }); }
  catch (e) { return { status: 'Failed', error: scrub(e) }; }
  if (side === 'buy' && refPriceSol > 0 && decimals != null) {          // no comprar a un precio mucho peor que el del bot origen (llegamos tarde / pico)
    const inA = Number(order.inAmount), outA = Number(order.outAmount);
    if (inA > 0 && outA > 0) {
      const ours = (inA / 1e9) / (outA / 10 ** decimals);
      if (ours > refPriceSol * (1 + maxDev)) return { status: 'Skipped', error: `price moved too much (${(((ours / refPriceSol) - 1) * 100).toFixed(0)}% above the bot's)` };
    }
  }
  let signed; try { signed = d.signOrderTx(order.transaction, kp); } catch (e) { return { status: 'Failed', error: scrub(e) }; }
  const res = await d.execute({ signedTransaction: signed, requestId: order.requestId });
  return { ...res, outAmount: res.totalOutputAmount ?? order.outAmount };
}

// ---------- libro de posiciones vs blockchain ----------
// El libro (live.positions) solo sirve para calcular el tope total. La verdad es la wallet: si una posición ya no tiene saldo
// (venta con resultado incierto, retiro) se borra, para que un resultado 'Unknown' nunca deje el tope bloqueado.
export async function reconcileLedger(live, chain) {
  for (const mint of Object.keys(live.positions)) {
    try { if ((await chain.tokenRaw(mint)) <= 0n) delete live.positions[mint]; } catch (e) { /* RPC caído: se conserva */ }
  }
}

// ---------- vender (nunca se pierde una salida) ----------
// Devuelve 'done' | 'unknown' | 'retry' | 'none'. 'retry' = no se pudo ahora; el llamante lo deja PENDIENTE.
async function sellMint({ live, mint, sym, frac, price, at, deps }) {
  const { chain, swap } = deps, sleep = deps.sleep || sleepReal;
  const bal = await chain.tokenRaw(mint);                           // si esto lanza, el llamante lo deja pendiente
  if (bal <= 0n) { delete live.positions[mint]; return 'none'; }
  const amountRaw = frac >= 0.99 ? bal : (bal * BigInt(Math.floor(frac * 1e6))) / 1000000n;
  if (amountRaw <= 0n) return 'none';
  let res;
  for (let i = 0; i < 3; i++) { res = await swap({ side: 'sell', mint, amountRaw: String(amountRaw), decimals: null, refPriceSol: price }); if (res.status !== 'Failed') break; await sleep(1500); }
  if (res.status === 'Success') {
    const got = Number(res.outAmount || 0) / 1e9, p = live.positions[mint], costPart = p ? p.costSol * (frac >= 0.99 ? 1 : frac) : 0;
    if (p) { p.costSol -= costPart; if (frac >= 0.99) delete live.positions[mint]; }
    note(live, { at, type: 'sell', mint, sym: (p && p.sym) || sym, sol: +got.toFixed(4), sig: res.signature, price, pnl: p ? +(got - costPart).toFixed(4) : undefined });
    return 'done';
  }
  if (res.status === 'Unknown') { note(live, { at, type: 'error', side: 'sell', mint, sym, reason: res.error || 'unconfirmed: checking', sig: res.signature || undefined, unknown: true }); return 'unknown'; }   // no se repite: podría haberse ejecutado
  note(live, { at, type: 'error', side: 'sell', mint, sym, reason: (res.error || res.status) + ' — will retry' });
  return 'retry';
}
const schedule = (live, mint, sym, frac, price, now) => {
  const p = live.pending[mint];
  live.pending[mint] = { sym, price, frac: Math.max(frac, p ? p.frac : 0), tries: p ? p.tries : 0, firstAt: p ? p.firstAt : now, lastAt: p ? p.lastAt : 0 };
};
// Reintenta las ventas pendientes (acotado: 12 intentos / 30 min, 20 s entre intentos).
export async function retryPendingSells({ live, deps, now = Date.now }) {
  let changed = false;
  for (const [mint, p] of Object.entries(live.pending || {})) {
    if (now() - p.firstAt > SELL_RETRY.windowMs || p.tries >= SELL_RETRY.maxTries) { note(live, { at: now(), type: 'error', side: 'sell', mint, sym: p.sym, reason: 'gave up selling after repeated failures: sell it from the withdraw button' }); delete live.pending[mint]; changed = true; continue; }
    if (now() - p.lastAt < SELL_RETRY.minGapMs) continue;
    p.tries++; p.lastAt = now(); changed = true;
    let r; try { r = await sellMint({ live, mint, sym: p.sym, frac: p.frac, price: p.price, at: now(), deps }); } catch (e) { r = 'retry'; }
    if (r !== 'retry') delete live.pending[mint];
  }
  return changed;
}

// ---------- una operación de la fuente ----------
// deps: { chain:{ solLamports(), tokenRaw(mint), decimals(mint) }, swap(args), persist(), sleep? }
export async function processLiveItem({ live, cfg, item, sinceMs, deps, now = Date.now }) {
  if (!item || !item.sig || live.done.includes(item.sig)) return false;
  if (toMs(item.at) < sinceMs) return false;                        // anterior a la autorización: no se copia
  live.done.push(item.sig); if (live.done.length > 300) live.done.splice(0, live.done.length - 300);
  const price = num(item.priceSol, 0), mint = item.mint;
  if (!isAddr(mint) || mint === SOL_MINT || !(price > 0)) return true;
  const sym = String(item.sym || '').slice(0, 16), at = toMs(item.at), { chain, swap, persist } = deps;
  const frac = clamp(num(item.sellFrac, 1), 0.01, 1);

  if (item.side === 'sell') {                                       // las SALIDAS tienen prioridad y nunca se pierden
    if (!cfg.sells) return true;
    schedule(live, mint, sym, frac, price, now());                  // se guarda como pendiente ANTES de intentarlo: si todo falla o el motor cae, se reintenta
    await persist();
    let r; try { r = await sellMint({ live, mint, sym, frac, price, at, deps }); } catch (e) { r = 'retry'; note(live, { at, type: 'error', side: 'sell', mint, sym, reason: scrub(e) + ' — will retry' }); }
    if (r !== 'retry') delete live.pending[mint]; else { live.pending[mint].tries++; live.pending[mint].lastAt = now(); }
    return true;
  }

  await persist();                                                  // intención guardada ANTES de mover dinero: tras una caída no se repite
  if (item.side === 'buy') {
    if (!cfg.buys) return true;
    await reconcileLedger(live, chain);                             // tope total sobre lo que realmente hay en la wallet
    const balSol = Number((await chain.solLamports()) - BigInt(RESERVE_LAMPORTS)) / 1e9;
    const s = copySize(cfg, item.sol, { cash: balSol, positions: live.positions });
    if (s.skip) { note(live, { at, type: 'skip', side: 'buy', mint, sym, reason: s.skip }); return true; }
    const amountRaw = String(Math.floor(s.sol * 1e9));
    const res = await swap({ side: 'buy', mint, amountRaw, decimals: await chain.decimals(mint), refPriceSol: price });
    if (res.status === 'Success' || res.status === 'Unknown') {     // incierto = se asume ejecutado a efectos del tope; la conciliación lo corrige después
      const spent = Number(res.totalInputAmount ?? amountRaw) / 1e9, p = live.positions[mint] || (live.positions[mint] = { mint, sym, costSol: 0 });
      p.costSol += spent;
      note(live, res.status === 'Success' ? { at, type: 'buy', mint, sym, sol: +spent.toFixed(4), sig: res.signature, price } : { at, type: 'error', side: 'buy', mint, sym, reason: res.error || 'unconfirmed: counted against your limit', sig: res.signature || undefined, unknown: true });
    } else if (res.status === 'Skipped') note(live, { at, type: 'skip', side: 'buy', mint, sym, reason: res.error });
    else note(live, { at, type: 'error', side: 'buy', mint, sym, reason: res.error || res.status });
  }
  return true;
}

// ---------- ciclo ----------
const liveGate = { last: 0 };
export function chainFor(conn, pub) {
  return { solLamports: () => solBalance(conn, pub), tokenRaw: async m => (await tokenBalance(conn, pub, m)).raw, decimals: m => mintDecimals(conn, m) };
}
export async function solLiveTick({ store, fetchFeed, conn, now = Date.now, minGapMs = 10000, gate = liveGate, enabled = liveEnabled, sleep, swapDeps, log = console.error, concurrency = CONCURRENCY }) {
  if (!enabled()) return { skipped: 'live-disabled' };
  if (now() - gate.last < minGapMs) return { skipped: 'gap' };
  gate.last = now();
  const users = await store.kvGet('solbot:users', {});
  const act = Object.entries(users).filter(([, u]) => u && u.active && u.mode === 'live' && isAddr(u.wallet));
  if (!act.length) return { users: 0 };
  const feed = await fetchFeed();
  if (!feed || !Array.isArray(feed.items)) return { error: 'feed' };
  const signalOff = !!(feed.signal && feed.signal.on === false);     // el interruptor general solo frena operaciones NUEVAS; las ventas pendientes siguen
  const items = [...feed.items].sort((a, b) => toMs(a.at) - toMs(b.at)), wallets = await store.kvGet('solbot:botwallets', {});
  let processed = 0;
  const runUser = ([uid, u]) => withUserLock(uid, async () => {
    let kp; try { kp = loadBotKeypair(Object.hasOwn(wallets, uid) ? wallets[uid] : null); } catch (e) { log('solbot live', uid.slice(0, 6), scrub(e, 100)); return; }
    const live = (await store.kvGet('solbot:live:' + uid, null)) || freshLive(); if (!live.pending) live.pending = {};
    const cfg = liveCfg(u.cfg || {});
    const deps = { chain: chainFor(conn, kp.publicKey.toBase58()), swap: a => liveSwap({ kp, ...a, deps: swapDeps }), persist: () => store.kvSet('solbot:live:' + uid, live), sleep };
    if (await retryPendingSells({ live, deps }).catch(() => false)) await store.kvSet('solbot:live:' + uid, live).catch(() => {});
    if (signalOff) return;
    const todo = items.filter(it => it && it.sig && !live.done.includes(it.sig) && toMs(it.at) >= num(u.since, 0));   // solo lo nuevo: el chequeo de pausa (1 lectura) se hace únicamente antes de actuar
    for (const it of todo) {
      const cur = (await store.kvGet('solbot:users', {}))[uid];     // si pausa / desconecta / reconecta, se para al momento
      if (!cur || !cur.active || cur.mode !== 'live' || cur.since !== u.since) break;
      try { if (await processLiveItem({ live, cfg, item: it, sinceMs: num(u.since, 0), deps })) { processed++; await store.kvSet('solbot:live:' + uid, live); } }
      catch (e) { note(live, { at: Date.now(), type: 'error', mint: it.mint, reason: scrub(e) }); await store.kvSet('solbot:live:' + uid, live).catch(() => {}); }
    }
  });
  const queue = [...act];                                           // usuarios en paralelo (con tope): la lentitud de uno no retrasa a los demás
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { while (queue.length) await runUser(queue.shift()); }));
  return { users: act.length, processed };
}

// ---------- retirar ----------
// Vende (opcional) todos los tokens a SOL y envía el SOL a la wallet de cobro VERIFICADA del usuario (el destino nunca viene de la petición).
export async function withdrawAll({ conn, kp, to, sellAll, swapDeps, sleep = sleepReal }) {
  const pub = kp.publicKey.toBase58(), sold = [], failed = [];
  if (sellAll) {
    for (const t of await allTokens(conn, pub)) {
      let res; for (let i = 0; i < 3; i++) { res = await liveSwap({ kp, side: 'sell', mint: t.mint, amountRaw: String(t.raw), decimals: t.decimals, refPriceSol: 0, deps: swapDeps }); if (res.status !== 'Failed') break; await sleep(1500); }
      (res.status === 'Success' ? sold : failed).push({ mint: t.mint, ...(res.status === 'Success' ? { sig: res.signature } : { reason: res.error || res.status }) });
    }
  }
  // Si quedan tokens (no vendidos, o no se pidió vender), se deja SOL para poder venderlos después: sin SOL no hay comisiones de red.
  const holding = sellAll ? failed.length : (await allTokens(conn, pub)).length;
  const keep = holding ? BigInt(RESERVE_LAMPORTS) : 0n;
  const lamports = (await solBalance(conn, pub)) - BigInt(TRANSFER_FEE_LAMPORTS) - keep;
  if (lamports <= 0n) return { sold, failed, signature: null, lamports: 0, note: 'no hay SOL que retirar' };
  const signature = await transferSol(conn, kp, to, lamports);
  return { sold, failed, signature, lamports: Number(lamports), keptReserve: holding > 0 };
}
