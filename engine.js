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
import { startApi } from './api.js';

// --- mini cargador de .env (sin dependencias) ---
try { for (const line of fs.readFileSync('.env', 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch (e) {}

const MODE = (process.env.EXEC_MODE || 'paper').toLowerCase();
const POLL = Number(process.env.SIGNALS_POLL_MS || 5000);
const SRC = process.env.SIGNALS_URL || 'file://./signals.sample.json';
const lastPriceBySymbol = {};

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

async function processSignal(sig) {
  lastPriceBySymbol[sig.symbol] = sig.price;
  const clients = store.clients();
  const st = store.state();
  for (const c of clients) {
    if (!c.active || c.cfg?.active === false) continue;
    const posList = (st.positions[c.uid] ||= []);
    const clientOrderId = `${c.uid}-${sig.id}`;
    if (posList.some(p => p.clientOrderId === clientOrderId)) continue; // idempotencia

    try {
      let balanceUsd = Number(c.cfg?.paperBalanceUsd || 1000), live = null;
      if (MODE === 'live') { live = await liveClient(c); balanceUsd = await live.ex.balanceUSDT(live.client); }

      if (sig.action === 'close') {
        if (MODE === 'live' && live) { for (const p of posList.filter(p => p.symbol === sig.symbol)) { try { if (p.stopOrderId) await live.client.cancelOrder(p.stopOrderId, sig.symbol); await live.ex.placeOrder(live.client, { symbol: sig.symbol, side: p.side === 'long' ? 'sell' : 'buy', amount: p.amount, type: 'market', clientOrderId, params: { reduceOnly: true } }); } catch (e) {} } }
        st.positions[c.uid] = posList.filter(p => p.symbol !== sig.symbol);
        store.logOrder({ mode: MODE, uid: c.uid, signalId: sig.id, symbol: sig.symbol, action: 'close', status: MODE === 'live' ? 'sent' : 'paper-closed' });
        console.log(`[${MODE}] ${c.uid} close ${sig.symbol}`);
        continue;
      }

      const openExposureUsd = posList.reduce((a, p) => a + (p.amountUsd || 0), 0);
      const size = sizeForClient({ cfg: c.cfg, balanceUsd, openExposureUsd, signalPrice: sig.price });
      if (size.blocked) { store.logOrder({ mode: MODE, uid: c.uid, signalId: sig.id, status: 'skipped', reason: size.reason }); continue; }

      const side = sig.side === 'buy' ? 'long' : 'short';
      let exchangeOrderId = null, status = 'paper-filled';
      if (MODE === 'live' && live) { const res = await live.ex.placeOrder(live.client, { symbol: sig.symbol, side: sig.side, amount: size.amountAsset, type: 'market', clientOrderId }); exchangeOrderId = res.id; status = 'sent'; }

      posList.push({ clientOrderId, symbol: sig.symbol, side, entry: sig.price, amount: size.amountAsset, amountUsd: size.amountUsd, stop: null, peak: sig.price, armed: false, at: Date.now() });
      store.logOrder({ mode: MODE, uid: c.uid, clientOrderId, signalId: sig.id, symbol: sig.symbol, side, action: 'open', amountUsd: size.amountUsd, entry: sig.price, exchangeOrderId, status });
      console.log(`[${MODE}] ${c.uid} open ${side} ${sig.symbol} ~$${size.amountUsd.toFixed(2)} (${status})`);
    } catch (e) {
      store.logOrder({ mode: MODE, uid: c.uid, signalId: sig.id, status: 'error', reason: String(e.message || e) });
      console.error(`[${MODE}] ${c.uid} ERROR:`, e.message || e);
    }
  }
  st.lastSignalId = sig.id;
  store.saveState(st);
}

// Reconciliación + trailing stop para todas las posiciones abiertas.
async function reconcileAll() {
  const clients = store.clients();
  const st = store.state();
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
  if (dirty) store.saveState(st);
}

async function tick() {
  const signals = await fetchSignals();
  const st = store.state();
  let start = 0;
  if (st.lastSignalId != null) { const i = signals.findIndex(s => s.id === st.lastSignalId); start = i >= 0 ? i + 1 : 0; }
  for (const sig of signals.slice(start)) await processSignal(sig);
  await reconcileAll();
}

async function main() {
  startApi();
  console.log(`StayLiquid Engine · modo=${MODE} · fuente=${SRC} · poll=${POLL}ms`);
  if (MODE === 'live') console.log('*** MODO LIVE: ordenes REALES. Valida en paper antes. ***');
  for (;;) { await tick().catch(e => console.error('tick error', e)); await new Promise(r => setTimeout(r, POLL)); }
}
main();
