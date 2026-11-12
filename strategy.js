// ============================================================================
// STRATEGY · corre la MISMA estrategia del bot (PRO Selectivo) con datos reales
// de BTC y emite señales abrir/cerrar. Así cada cliente conectado copia al bot
// EN SYNC: abre cuando el bot abre y cierra cuando el bot cierra.
// ----------------------------------------------------------------------------
// Parámetros idénticos al backtest/btc.html: LOOK=288, N=3, S0=0.6%, ARM=1.2%, TR=2%.
// El estado se guarda entre ciclos (store.strategyState) para seguir donde lo dejó.
// Primer arranque: calienta con el histórico en silencio (no emite trades viejos),
// fija el último bar y a partir de ahí emite solo lo NUEVO, igual que el bot.
// ============================================================================
const P = { LOOK: 288, N: 3, S0: 0.006, ARM: 0.012, TR: 0.02, ZONE: 0.001 };
const SYMBOL = 'BTC/USDT';

// --- velas 5m: Binance.vision -> Coinbase (las mismas fuentes que la web) ---
async function binance5m(sinceSec) {
  const out = []; let t = sinceSec * 1000;
  for (let p = 0; p < 7; p++) {
    const u = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${t}&limit=1000`;
    let j; try { const r = await fetch(u); if (!r.ok) break; j = await r.json(); } catch (e) { break; }
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) out.push({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    const nx = j[j.length - 1][6] + 1; if (nx <= t) break; t = nx; if (j.length < 1000) break;
  }
  return out;
}
async function coinbase5m(sinceSec) {
  const out = []; let end = Math.floor(Date.now() / 1000);
  for (let p = 0; p < 6; p++) {
    const start = Math.max(sinceSec, end - 300 * 300);
    const u = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    let j; try { const r = await fetch(u, { headers: { 'user-agent': 'stayliquid-engine' } }); if (!r.ok) break; j = await r.json(); } catch (e) { break; }
    if (!Array.isArray(j) || !j.length) break;
    for (const c of j) out.push({ t: c[0], o: +c[3], h: +c[2], l: +c[1], c: +c[4] });
    const e = Math.min.apply(0, j.map(c => c[0])); if (e <= sinceSec) break; end = e - 300;
  }
  return out.sort((a, b) => a.t - b.t);
}
export async function fetchCandles(sinceSec) {
  for (const src of [binance5m, coinbase5m]) {
    try { const b = await src(sinceSec); if (b && b.length) { const m = new Map(); for (const x of b) if (x.c > 0) m.set(x.t, x); return [...m.values()].sort((a, b) => a.t - b.t); } } catch (e) {}
  }
  return [];
}

function freshState() { return { H: [], Lw: [], trend: 0, brk: null, brkId: 0, open: [], lastBarT: 0, idc: 0, warmed: false }; }

// Procesa barras nuevas y devuelve las señales (abrir/cerrar) producidas.
function step(s, bars, emit) {
  for (const b of bars) {
    if (b.t <= s.lastBarT) continue;
    s.H.push(b.h); s.Lw.push(b.l); if (s.H.length > P.LOOK) { s.H.shift(); s.Lw.shift(); }
    if (s.H.length >= P.LOOK) {
      const hh = Math.max(...s.H.slice(0, -1)), ll = Math.min(...s.Lw.slice(0, -1));
      if (b.c > hh && s.trend !== 1) { s.trend = 1; s.brk = hh; s.brkId++; }
      else if (b.c < ll && s.trend !== -1) { s.trend = -1; s.brk = ll; s.brkId++; }
    }
    // gestiona posiciones abiertas (trailing + stop) -> cierres
    for (const p of s.open) {
      if (p.closed) continue;
      p.peak = p.dir > 0 ? Math.max(p.peak, b.h) : Math.min(p.peak, b.l);
      const fav = p.dir > 0 ? p.peak / p.entry - 1 : 1 - p.peak / p.entry;
      if (!p.armed && fav >= P.ARM) { p.armed = true; p.stop = p.entry; }
      if (p.armed) { const ts = p.dir > 0 ? p.peak * (1 - P.TR) : p.peak * (1 + P.TR); p.stop = p.dir > 0 ? Math.max(p.stop, ts) : Math.min(p.stop, ts); }
      const hit = p.dir > 0 ? b.l <= p.stop : b.h >= p.stop;
      if (hit) { p.closed = true; if (emit) emit({ id: 'st-' + (++s.idc), posId: p.posId, symbol: SYMBOL, side: p.dir > 0 ? 'sell' : 'buy', action: 'close', price: +p.stop.toFixed(1) }); }
    }
    s.open = s.open.filter(p => !p.closed);
    // nueva entrada (pullback + confirmación + no repetir el mismo breakout)
    if (s.trend !== 0 && s.brk && s.open.length < P.N) {
      const pulled = s.trend > 0 ? b.l <= s.brk * (1 + P.ZONE) : b.h >= s.brk * (1 - P.ZONE);
      const confirm = s.trend > 0 ? b.c > b.o : b.c < b.o;
      const fresh = !s.open.some(p => p.brkId === s.brkId);
      if (pulled && confirm && fresh) {
        const posId = 'p' + s.brkId + '-' + (s.idc + 1);
        s.open.push({ dir: s.trend, entry: b.c, t0: b.t, brkId: s.brkId, stop: s.trend > 0 ? b.c * (1 - P.S0) : b.c * (1 + P.S0), armed: false, peak: b.c, closed: false, posId });
        if (emit) emit({ id: 'st-' + (++s.idc), posId, symbol: SYMBOL, side: s.trend > 0 ? 'buy' : 'sell', action: 'open', price: +b.c.toFixed(1) });
      }
    }
    s.lastBarT = b.t;
  }
}

// tick(): llamado cada ciclo por el motor. Devuelve { signals, state }.
export async function tick(prevState) {
  let s = prevState && prevState.lastBarT ? prevState : freshState();
  const since = s.lastBarT ? s.lastBarT - 5 : Math.floor(Date.now() / 1000) - P.LOOK * 300 * 3; // calentamiento ~3x LOOK
  const bars = await fetchCandles(since);
  if (!bars.length) return { signals: [], state: s };
  const signals = [];
  if (!s.warmed) { step(s, bars, null); s.warmed = true; return { signals: [], state: s }; } // primer arranque: silencio
  step(s, bars, sig => signals.push(sig));
  return { signals, state: s };
}

export const __test = { freshState, step, SYMBOL, P };
