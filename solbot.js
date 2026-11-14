// ============================================================================
// SOLBOT · Copy Bot de Solana en SIMULACIÓN (dinero virtual)
// ----------------------------------------------------------------------------
// El usuario conecta su wallet (verificada por firma en el worker) y elige ajustes. El motor copia, con fondos
// VIRTUALES, cada operación nueva del bot StayLiquid (feed público /api/copy/feed). NO mueve dinero real, NO guarda
// ninguna clave privada y NO envía transacciones: es la fase de prueba antes de ofrecer ejecución real.
//
// Honestidad de la simulación: se descuentan la comisión de StayLiquid (110 bps) y un deslizamiento supuesto
// (100 bps) en cada operación, para no inflar resultados. Aun así es una simulación, no un resultado real.
// ============================================================================
export const FEE_BPS = 110, SLIP_BPS = 100, START_SOL = 10, MIN_TRADE_SOL = 0.01;
const FEE = FEE_BPS / 1e4, SLIP = SLIP_BPS / 1e4;
const MAX_TRADES = 100, MAX_DONE = 300;

export const isAddr = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Ajustes del usuario con límites duros (la validación autoritativa es esta, no la del navegador).
export function normalizeCfg(c) {
  c = c && typeof c === 'object' ? c : {};
  const mode = c.mode === 'ratio' ? 'ratio' : 'fixed';
  return {
    mode,
    fixedSol: clamp(num(c.fixedSol, 0.1), 0.01, 5),
    ratio: clamp(num(c.ratio, 0.1), 0.01, 1),
    maxPerTradeSol: clamp(num(c.maxPerTradeSol, 1), 0.01, 10),
    maxTotalSol: clamp(num(c.maxTotalSol, 3), 0.01, 10),
    buys: c.buys !== false,
    sells: c.sells !== false,
  };
}

export const freshPaper = () => ({ startSol: START_SOL, cash: START_SOL, realized: 0, positions: {}, trades: [], done: [], last: {} });

const exposure = paper => Object.values(paper.positions).reduce((a, p) => a + p.cost, 0);
const markValue = (p, price) => p.qty * price * (1 - SLIP) * (1 - FEE);

// Cuánto copiar de una compra de la fuente. Devuelve { sol } o { skip: motivo }.
export function copySize(cfg, srcSol, paper) {
  const raw = cfg.mode === 'ratio' ? num(srcSol, 0) * cfg.ratio : cfg.fixedSol;
  const room = cfg.maxTotalSol - exposure(paper);
  const sol = Math.min(raw, cfg.maxPerTradeSol, room, paper.cash);
  if (!(sol >= MIN_TRADE_SOL)) return { skip: room < MIN_TRADE_SOL ? 'total limit reached' : paper.cash < MIN_TRADE_SOL ? 'no virtual balance' : 'amount too small' };
  return { sol };
}

export const toMs = at => { const n = Number(at); return n > 1e12 ? n : n * 1000; };
export const note = (paper, t) => { paper.trades.unshift(t); if (paper.trades.length > MAX_TRADES) paper.trades.length = MAX_TRADES; };

// Aplica UNA operación de la fuente a la cuenta virtual. Idempotente por sig. Devuelve true si cambió algo.
export function applyItem(paper, cfg, item, sinceMs) {
  if (!item || !item.sig || paper.done.includes(item.sig)) return false;
  if (toMs(item.at) < sinceMs) return false;                         // anterior a la conexión: no se copia
  paper.done.push(item.sig); if (paper.done.length > MAX_DONE) paper.done.splice(0, paper.done.length - MAX_DONE);
  const price = num(item.priceSol, 0), mint = item.mint;
  if (!isAddr(mint) || !(price > 0)) return true;                    // dato inservible: se marca visto y se ignora
  paper.last[mint] = price;
  const sym = String(item.sym || '').slice(0, 16), at = toMs(item.at);

  if (item.side === 'buy') {
    if (!cfg.buys) return true;
    const s = copySize(cfg, item.sol, paper);
    if (s.skip) { note(paper, { at, type: 'skip', side: 'buy', mint, sym, reason: s.skip }); return true; }
    const qty = (s.sol * (1 - FEE)) / (price * (1 + SLIP));
    const p = paper.positions[mint] || (paper.positions[mint] = { mint, sym, qty: 0, cost: 0 });
    p.qty += qty; p.cost += s.sol; paper.cash -= s.sol;
    note(paper, { at, type: 'buy', mint, sym, sol: +s.sol.toFixed(4), price });
  } else if (item.side === 'sell') {
    if (!cfg.sells) return true;
    const p = paper.positions[mint]; if (!p) return true;            // no teníamos esa moneda
    const frac = clamp(num(item.sellFrac, 1), 0.01, 1);
    const qty = frac >= 0.99 ? p.qty : p.qty * frac, costPart = p.cost * (qty / p.qty);
    const net = qty * price * (1 - SLIP) * (1 - FEE);
    paper.cash += net; paper.realized += net - costPart; p.qty -= qty; p.cost -= costPart;
    if (p.qty <= 1e-9) delete paper.positions[mint];
    note(paper, { at, type: 'sell', mint, sym: p.sym || sym, sol: +net.toFixed(4), price, pnl: +(net - costPart).toFixed(4) });
  }
  return true;
}

export function summary(paper) {
  const positions = Object.values(paper.positions).map(p => {
    const price = paper.last[p.mint] || 0, value = markValue(p, price);
    return { mint: p.mint, sym: p.sym, qty: p.qty, costSol: +p.cost.toFixed(4), valueSol: +value.toFixed(4), pnlSol: +(value - p.cost).toFixed(4) };
  });
  const unrealized = positions.reduce((a, p) => a + p.pnlSol, 0);
  const equity = paper.cash + positions.reduce((a, p) => a + p.valueSol, 0);
  return { startSol: paper.startSol, cash: +paper.cash.toFixed(4), realized: +paper.realized.toFixed(4), unrealized: +unrealized.toFixed(4),
    equity: +equity.toFixed(4), pnlPct: +((equity / paper.startSol - 1) * 100).toFixed(2), positions, trades: paper.trades.slice(0, 20) };
}

const gate = { last: 0 };
// Un ciclo: lee el feed público y aplica lo nuevo a cada usuario activo. deps: { store, fetchFeed, now?, minGapMs?, gate? }
export async function solbotTick({ store, fetchFeed, now = Date.now, minGapMs = 10000, gate: g = gate }) {
  if (now() - g.last < minGapMs) return { skipped: 'gap' };
  g.last = now();
  const users = await store.kvGet('solbot:users', {});
  const active = Object.entries(users).filter(([, u]) => u && u.active && u.mode !== 'live' && isAddr(u.wallet));   // los usuarios 'live' los lleva sollive.js
  if (!active.length) return { users: 0 };
  const feed = await fetchFeed();
  if (!feed || !Array.isArray(feed.items)) return { error: 'feed' };
  if (feed.signal && feed.signal.on === false) return { skipped: 'signal-off' };   // interruptor general del dueño
  const items = [...feed.items].sort((a, b) => toMs(a.at) - toMs(b.at));
  let changedUsers = 0;
  for (const [uid, u] of active) {
    const paper = (await store.kvGet('solbot:paper:' + uid, null)) || freshPaper();
    const cfg = normalizeCfg(u.cfg); let changed = false;
    for (const it of items) if (applyItem(paper, cfg, it, num(u.since, 0))) changed = true;
    if (!changed) continue;
    // Si mientras tanto el usuario se desconectó o reconectó (otra wallet / reinicio), no se pisa su cuenta nueva con la vieja.
    const now2 = (await store.kvGet('solbot:users', {}))[uid];
    if (!now2 || now2.wallet !== u.wallet || now2.since !== u.since || !now2.active) continue;
    await store.kvSet('solbot:paper:' + uid, paper); changedUsers++;
  }
  return { users: active.length, changedUsers };
}

export async function fetchPublicFeed(url = process.env.SOLBOT_FEED_URL || 'https://stayliquid.tech/api/copy/feed?limit=60') {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('feed HTTP ' + r.status);
  return r.json();
}
