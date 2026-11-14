// ============================================================================
// PARTIAL · venta parcial anticipada ("reduce") de forma segura
// ----------------------------------------------------------------------------
// Reglas (corrigen la revisión del commit 2f4419d):
//  - Un error del exchange NUNCA se traga: si la orden falla, el estado de la posición
//    NO cambia (sigue entera) y se programa un reintento acotado.
//  - La cantidad se redondea a la precisión del exchange y se respetan los mínimos;
//    si no se puede cortar (cantidad o resto bajo el mínimo) se omite y se registra.
//  - Idempotente: la orden lleva un clientOrderId determinista por posición, y la
//    intención se guarda ANTES de enviar. Si el motor cae y repite, el exchange
//    rechaza el duplicado y lo damos por hecho (no se vende dos veces).
//  - Tras cortar, el stop en reposo del exchange se vuelve a colocar con el tamaño nuevo.
// ============================================================================
import { createHash } from 'node:crypto';
import { applyStopOrder } from './risk.js';

export const FRAC_MIN = 0.05, FRAC_MAX = 0.95;
export const RETRY = { maxTries: 3, windowMs: 120000, minGapMs: 5000 };

export function clampFrac(f) {
  const n = Number(f);
  return Math.min(FRAC_MAX, Math.max(FRAC_MIN, Number.isFinite(n) && n > 0 ? n : 0.5));
}

// clientOrderId estable por (cliente, posición). Máx 33 caracteres, solo [a-z0-9].
export function reduceOrderId(uid, posId) {
  return 'slr' + createHash('sha1').update(`${uid}|${posId}|reduce`).digest('hex').slice(0, 30);
}

// ¿el exchange rechaza porque ya existe una orden con ese clientOrderId?
export function isDuplicateError(e) {
  const msg = String((e && (e.message || e)) || '');
  return (e && e.name === 'DuplicateOrderId') || /duplicate|already (exists|been used)|client ?order ?id.*(exist|used)/i.test(msg);
}

// Calcula cuánto vender. rules = { round(x) -> Number, min }. Devuelve { ok, cut, rest } o { ok:false, reason }.
export function planCut(amount, frac, { round = x => x, min = 0 } = {}) {
  if (!(amount > 0)) return { ok: false, reason: 'no_amount' };
  const cut = round(amount * frac);
  if (!(cut > 0)) return { ok: false, reason: 'cut_rounds_to_zero' };
  if (cut < min) return { ok: false, reason: 'cut_below_min' };
  const rest = amount - cut;
  if (!(rest > 0) || rest < min) return { ok: false, reason: 'rest_below_min' };
  return { ok: true, cut, rest };
}

// Ejecuta (o simula) el corte de UNA posición. Muta p solo si el corte se completa.
// deps: { mode, live:{ex,client}|null, persist:async()=>void, now?:()=>number }
// Devuelve { status: 'done'|'skipped'|'failed'|'noop', cutUsd?, reason?, stopOk? }
export async function executeReduce({ p, uid, symbol, frac, deps }) {
  const { mode, live, persist, now = Date.now } = deps;
  if (p.preCut || p.closePending) return { status: 'noop' };   // si se está cerrando entera, no se trocea
  const f = clampFrac(frac);
  const isLive = mode === 'live' && live;

  let plan;
  try {
    const rules = isLive ? await live.ex.amountRules(live.client, symbol) : {};
    plan = planCut(p.amount, f, rules);
  } catch (e) {
    return markFailed(p, f, now, 'rules: ' + String(e.message || e));
  }
  if (!plan.ok) { p.preCut = true; p.preCutNote = plan.reason; delete p.reducePending; return { status: 'skipped', reason: plan.reason }; }

  if (isLive) {
    const orderId = reduceOrderId(uid, p.posId || p.symbol);
    p.preCutInFlight = orderId;               // intención guardada ANTES de enviar
    await persist();
    try {
      await live.ex.placeOrder(live.client, { symbol, side: p.side === 'long' ? 'sell' : 'buy', amount: plan.cut, type: 'market', clientOrderId: orderId, params: { reduceOnly: true } });
    } catch (e) {
      if (!isDuplicateError(e)) { delete p.preCutInFlight; return markFailed(p, f, now, String(e.message || e)); }
      // duplicado = la orden ya se envió en un intento anterior: se da por hecha
    }
    delete p.preCutInFlight;
  }

  const cutUsd = +((p.amountUsd || 0) * (plan.cut / p.amount)).toFixed(2);
  p.amountUsd = +((p.amountUsd || 0) - cutUsd).toFixed(2);
  p.amount = plan.rest;
  p.preCut = true;
  delete p.reducePending;

  let stopOk = null;
  if (isLive && p.stopOrderId && p.stop != null) {   // el stop en reposo debe cubrir solo lo que queda
    const r = await applyStopOrder(live.ex, live.client, p, symbol);
    stopOk = !!r.ok;
  }
  return { status: 'done', cutUsd, stopOk };
}

function markFailed(p, frac, now, error) {
  const prev = p.reducePending || { tries: 0 };
  p.reducePending = { frac, tries: prev.tries + 1, firstAt: prev.firstAt || now(), lastAt: now() };
  return { status: 'failed', error };
}

// ¿toca reintentar este corte pendiente? (acotado en intentos y en tiempo)
export function shouldRetry(p, now = Date.now()) {
  const r = p.reducePending;
  if (!r || p.preCut || p.closePending) return false;
  if (r.tries >= RETRY.maxTries) return false;
  if (now - r.firstAt > RETRY.windowMs) return false;
  return now - r.lastAt >= RETRY.minGapMs;
}
