// ============================================================================
// ENGINE · bucle principal del motor de ejecución (Fase 1 completa)
// ----------------------------------------------------------------------------
// - Arranca la API de conexión (panel del frontend habla con ella).
// - Lee señales de SIGNALS_URL y procesa solo las NUEVAS.
// - Abre/cierra en la cuenta de cada cliente con SUS reglas (importe, exposición).
// - Gestiona el riesgo como la estrategia: stop 0.6% + break-even 1.2% + trailing 2%.
// - Reconcilia con el exchange cada ciclo (nunca se descuadra).
// - EXEC_MODE=paper simula; EXEC_MODE=live envía órdenes reales.
//
// Arranque:  cp .env.example .env  &&  npm run keygen  (pega en MASTER_KEY_B64)
//            npm install  &&  npm start
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.js';
import { sizeForClient } from './sizing.js';
import { decryptSecret } from './vault.js';
import { reconcileClient } from './reconcile.js';
import { executeReduce as executePartial, clampFrac, shouldRetry } from './partial.js';
import { startApi } from './api.js';

// --- mini cargador de .env (sin dependencias) ---
try { for (const line of fs.readFileSync('.env', 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch (e) {}

const MODE = (process.env.EXEC_MODE || 'paper').toLowerCase();
const POLL = Number(process.env.SIGNALS_POLL_MS || 5000);
const SRC = process.env.SIGNALS_URL || 'file://./signals.sample.json';
// STRATEGY=on -> el motor corre la estrategia PRO Selectivo con datos reales de BTC
// y emite abrir/cerrar; cada cliente conectado copia al bot EN SYNC.
const STRATEGY = (process.env.STRATEGY || '').toLowerCase() === 'on' || SRC === 'strategy';
const lastPriceBySymbol = {};
let strat = null; async function stratMod() { if (!strat) strat = await import('./strategy.js'); return strat; }

async function fetchSignals() {
  if (SRC.startsWith('file://')) { try { return JSON.parse(fs.readFileSync(path.resolve(SRC.slice(7)), 'utf8')); } catch (e) { return []; } }
  try { const r = await fetch(SRC); return r.ok ? await r.json() : []; } catch (e) { return []; }
}

let EX = null; async function exMod() { if (!EX) EX = await import('./exchange.js'); return EX; }

// Construye el cliente de exchange (live) descifrando las claves solo en memoria.
async function liveClient(c) {
  const ex = await exMod();
  const creds = JSON.parse(decryptSecret(c.creds));
  const client = ex.makeClient({ exchange: c.exchange, ...creds });
  const chk = await ex.verifyTradeOnly(client);
  if (!chk.ok) throw new Error('clave rechazada (' + chk.reason + ')');
  return { ex, client };
}

// Misma posición que la señal (por posId; si no trae, por símbolo). Compartido por close y reduce.
const matcher = sig => p => sig.posId ? p.posId === sig.posId : p.symbol === sig.symbol;

// Ejecuta el corte parcial de una posición con las garantías de partial.js y lo registra.
async function runReduce({ p, c, st, symbol, frac, signalId, posId, live }) {
  const r = await executePartial({ p, uid: c.uid, symbol, frac, deps: { mode: MODE, live, persist: () => store.saveState(st) } });
  if (r.status === 'noop') return r;
  const base = { mode: MODE, uid: c.uid, signalId, posId, symbol, action: 'reduce' };
  if (r.status === 'done') {
    store.logOrder({ ...base, amountUsd: r.cutUsd, status: MODE === 'live' ? 'sent' : 'paper-reduced', stopResized: r.stopOk });
    console.log(`[${MODE}] ${c.uid} reduce ${Math.round(clampFrac(frac) * 100)}% ${symbol} (${posId || symbol})${r.stopOk === false ? ' · AVISO: no se pudo recolocar el stop' : ''}`);
  } else if (r.status === 'skipped') {
    store.logOrder({ ...base, status: 'skipped', reason: r.reason });
    console.log(`[${MODE}] ${c.uid} reduce omitido (${r.reason}) ${symbol} (${posId || symbol})`);
  } else {
    store.logOrder({ ...base, status: 'error', reason: r.error, tries: p.reducePending && p.reducePending.tries });
    console.error(`[${MODE}] ${c.uid} reduce FALLÓ (se reintentará): ${r.error}`);
  }
  return r;
}

// Reintenta (acotado) los cortes que fallaron: máx. 3 intentos en 2 minutos; la posición sigue entera mientras tanto.
async function retryReduces() {
  const clients = await store.clients();
  const st = await store.state();
  let dirty = false;
  for (const c of clients) {
    if (!c.active || c.cfg?.active === false) continue;
    for (const p of (st.positions[c.uid] || [])) {
      if (!shouldRetry(p)) continue;
      let live = null;
      if (MODE === 'live') { try { live = await liveClient(c); } catch (e) { continue; } }
      await runReduce({ p, c, st, symbol: p.symbol, frac: p.reducePending.frac, signalId: 'retry', posId: p.posId, live });
      dirty = true;
    }
  }
  if (dirty) await store.saveState(st);
}

async function processSignal(sig) {
  lastPriceBySymbol[sig.symbol] = sig.price;
  const clients = await store.clients();
  const st = await store.state();
  for (const c of clients) {
    if (!c.active || c.cfg?.active === false) continue;
    const posList = (st.positions[c.uid] ||= []);
    const clientOrderId = `${c.uid}-${sig.id}`;
    if (posList.some(p => p.clientOrderId === clientOrderId)) continue; // idempotencia

    try {
      let balanceUsd = Number(c.cfg?.paperBalanceUsd || 1000), live = null;
      if (MODE === 'live') { live = await liveClient(c); balanceUsd = await live.ex.balanceUSDT(live.client); }

      if (sig.action === 'close') {
        const match = matcher(sig);   // cierra la MISMA posición que cerró el bot
        if (MODE === 'live' && live) { for (const p of posList.filter(match)) { try { if (p.stopOrderId) await live.client.cancelOrder(p.stopOrderId, sig.symbol); await live.ex.placeOrder(live.client, { symbol: sig.symbol, side: p.side === 'long' ? 'sell' : 'buy', amount: p.amount, type: 'market', clientOrderId, params: { reduceOnly: true } }); } catch (e) {} } }
        if (!posList.some(match)) continue;
        st.positions[c.uid] = posList.filter(p => !match(p));
        store.logOrder({ mode: MODE, uid: c.uid, signalId: sig.id, posId: sig.posId, symbol: sig.symbol, action: 'close', status: MODE === 'live' ? 'sent' : 'paper-closed' });
        console.log(`[${MODE}] ${c.uid} close ${sig.symbol} (${sig.posId || sig.symbol})`);
        continue;
      }

      if (sig.action === 'reduce') {   // corte parcial anticipado: vende una fracción (reduceOnly) y mantiene el resto con su stop/trailing
        const targets = posList.filter(p => matcher(sig)(p) && !p.preCut);   // idempotente: como mucho una vez por posición
        if (!targets.length) continue;
        for (const p of targets) await runReduce({ p, c, st, symbol: sig.symbol, frac: sig.frac, signalId: sig.id, posId: sig.posId, live });
        await store.saveState(st);
        continue;
      }

      const openExposureUsd = posList.reduce((a, p) => a + (p.amountUsd || 0), 0);
      const size = sizeForClient({ cfg: c.cfg, balanceUsd, openExposureUsd, signalPrice: sig.price });
      if (size.blocked) { store.logOrder({ mode: MODE, uid: c.uid, signalId: sig.id, status: 'skipped', reason: size.reason }); continue; }

      const side = sig.side === 'buy' ? 'long' : 'short';
      let exchangeOrderId = null, status = 'paper-filled';
      if (MODE === 'live' && live) { const res = await live.ex.placeOrder(live.client, { symbol: sig.symbol, side: sig.side, amount: size.amountAsset, type: 'market', clientOrderId }); exchangeOrderId = res.id; status = 'sent'; }

      posList.push({ clientOrderId, posId: sig.posId || null, symbol: sig.symbol, side, entry: sig.price, amount: size.amountAsset, amountUsd: size.amountUsd, stop: null, peak: sig.price, armed: false, at: Date.now() });
      store.logOrder({ mode: MODE, uid: c.uid, clientOrderId, signalId: sig.id, symbol: sig.symbol, side, action: 'open', amountUsd: size.amountUsd, entry: sig.price, exchangeOrderId, status });
      console.log(`[${MODE}] ${c.uid} open ${side} ${sig.symbol} ~$${size.amountUsd.toFixed(2)} (${status})`);
    } catch (e) {
      store.logOrder({ mode: MODE, uid: c.uid, signalId: sig.id, status: 'error', reason: String(e.message || e) });
      console.error(`[${MODE}] ${c.uid} ERROR:`, e.message || e);
    }
  }
  st.lastSignalId = sig.id;
  await store.saveState(st);
}

// Reconciliación + trailing stop para todas las posiciones abiertas.
async function reconcileAll() {
  const clients = await store.clients();
  const st = await store.state();
  let dirty = false;
  for (const c of clients) {
    const positions = st.positions[c.uid];
    if (!positions || !positions.length) continue;
    const symbol = positions[0].symbol;
    let ex = null, client = null;
    if (MODE === 'live') { try { const lc = await liveClient(c); ex = lc.ex; client = lc.client; } catch (e) { continue; } }
    const kept = await reconcileClient({ mode: MODE, ex, client, uid: c.uid, positions, lastPrice: lastPriceBySymbol[symbol], symbol, log: e => store.logOrder(e) });
    if (kept.length !== positions.length) dirty = true;
    st.positions[c.uid] = kept;
  }
  if (dirty) await store.saveState(st);
}

async function tick() {
  if (STRATEGY) {
    // El motor corre la estrategia del bot y emite señales -> los clientes copian en sync.
    const sm = await stratMod();
    const { signals, state } = await sm.tick(await store.strategyState());
    for (const sig of signals) await processSignal(sig);
    // Se guarda DESPUÉS de procesar: si el motor cae a mitad, la próxima vuelta regenera las mismas señales
    // (mismos ids) y las repite; open/close/reduce son idempotentes, así que ninguna señal se pierde ni se duplica.
    await store.saveStrategyState(state);
    await retryReduces();
    return; // mirror puro: el cierre lo manda la estrategia, no un trailing independiente
  }
  const signals = await fetchSignals();
  const st = await store.state();
  let start = 0;
  if (st.lastSignalId != null) { const i = signals.findIndex(s => s.id === st.lastSignalId); start = i >= 0 ? i + 1 : 0; }
  for (const sig of signals.slice(start)) await processSignal(sig);
  await retryReduces();
  await reconcileAll();
}

async function main() {
  startApi();
  console.log(`StayLiquid Engine · modo=${MODE} · fuente=${SRC} · poll=${POLL}ms`);
  if (MODE === 'live') console.log('*** MODO LIVE: ordenes REALES. Valida en paper antes. ***');
  for (;;) { await tick().catch(e => console.error('tick error', e)); await new Promise(r => setTimeout(r, POLL)); }
}
main();
