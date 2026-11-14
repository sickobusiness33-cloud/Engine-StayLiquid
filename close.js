// ============================================================================
// CLOSE · cierre de una posición de forma segura
// ----------------------------------------------------------------------------
// Reglas (mismas garantías que partial.js, pero para el cierre total):
//  - Un error del exchange NUNCA se traga: si la orden falla, la posición SIGUE en el
//    estado del motor (y su stop en reposo sigue protegiéndola) y se programa un
//    reintento acotado (máx. 3 intentos en 2 minutos, constantes de partial.js).
//    Agotados los reintentos la posición NO se abandona: queda marcada (closePending)
//    para intervención manual y sigue gestionada (trailing/reconciliación).
//  - La cantidad se redondea a la precisión del exchange y se respeta el mínimo.
//    POLVO: si lo que hay es 0 o queda bajo el mínimo del par, el exchange rechazaría
//    cualquier orden. Decisión: no se envía nada, se LIBERA la posición del estado
//    (reintentar eternamente no serviría) y se devuelve status 'dust' con el motivo,
//    que el motor registra como 'skipped' y avisa por consola. Nunca en silencio.
//  - Idempotente: clientOrderId determinista por POSICIÓN (ligado a la orden de apertura,
//    no a posId/símbolo, para que reabrir el mismo símbolo no herede un id viejo) y la
//    intención (closePending) se guarda ANTES de enviar. Si el motor cae y repite, el
//    exchange rechaza el duplicado y se da por hecho (no se vende dos veces).
//  - El stop en reposo se cancela SOLO tras confirmar el cierre. Si el cierre falla, el
//    stop sigue activo. Si cancelar el stop falla tras cerrar, se informa (stopCancelled:
//    false) porque un stop reduceOnly huérfano podría tocar una posición futura.
// ============================================================================
import { createHash } from 'node:crypto';
import { RETRY, isDuplicateError } from './partial.js';

const MAX_ERR = 300; // el motivo se acota: los mensajes de ccxt pueden traer respuestas enteras
// Texto de error seguro para logs/estado: sin claves, firmas ni secretos, y acotado. Usar en TODO log o consola.
export function safeErr(e) {
  return String((e && (e.message || e)) || e)
    .replace(/(signature|sign|apikey|api[-_ ]?key|secret|password|passphrase|token|authorization)(["'\s]*[:=]["'\s]*)[^\s&"',}]+/gi, '$1$2[redacted]')
    .slice(0, MAX_ERR);
}
const errMsg = safeErr;

// clientOrderId estable por (cliente, posición). Máx 33 caracteres, solo [a-z0-9].
export function closeOrderId(uid, p) {
  const key = p.clientOrderId || p.posId || p.symbol;
  return 'slc' + createHash('sha1').update(`${uid}|${key}|close`).digest('hex').slice(0, 30);
}

// ¿cancelar un stop que ya no existe? No es un problema (saltó, o ya se canceló).
function isOrderNotFound(e) {
  const msg = String((e && (e.message || e)) || '');
  // estricto: "symbol not found" o "api key not found" NO son un stop ya inexistente
  return (e && e.name === 'OrderNotFound') || /unknown order|order\b.{0,30}(not found|does not exist)|already (closed|cancel+ed|filled)/i.test(msg);
}

// Cuánto vender para cerrar. rules = { round(x) -> Number, min }.
// Devuelve { ok, qty, residual } o { ok:false, reason } (reason: no_amount | rounds_to_zero | below_min).
export function planClose(amount, { round = x => x, min = 0 } = {}) {
  if (!(amount > 0)) return { ok: false, reason: 'no_amount' };
  const qty = round(amount);
  if (!(qty > 0)) return { ok: false, reason: 'rounds_to_zero' };
  if (qty < min) return { ok: false, reason: 'below_min' };
  const r = amount - qty;
  return { ok: true, qty, residual: r > amount * 1e-9 ? r : 0 };
}

// Anota un intento fallido. Exportado: el motor lo usa si ni siquiera pudo crear el cliente del exchange.
export function markCloseFailed(p, signalId, error, now = Date.now) {
  const prev = p.closePending || { tries: 0 };
  p.closePending = { ...prev, signalId: prev.signalId ?? signalId, tries: prev.tries + 1, firstAt: prev.tries > 0 ? prev.firstAt : now(), lastAt: now() };
  p.closePending.lastError = errMsg(error);   // visible en el estado, no solo en el log
  return { status: 'failed', error: p.closePending.lastError, tries: p.closePending.tries };
}

// ¿toca reintentar este cierre pendiente? (acotado en intentos y en tiempo)
export function shouldRetryClose(p, now = Date.now()) {
  const r = p.closePending;
  if (!r) return false;
  if (r.tries >= RETRY.maxTries) return false;
  // tries === 0: intención guardada que nunca llegó a resolverse (caída del motor): se reintenta aunque haya pasado tiempo
  if (r.tries > 0 && now - r.firstAt > RETRY.windowMs) return false;
  return now - r.lastAt >= RETRY.minGapMs;
}

// ¿se acabaron los reintentos automáticos de este cierre?
export function closeExhausted(p, now = Date.now()) {
  const r = p.closePending;
  return !!r && r.tries > 0 && (r.tries >= RETRY.maxTries || now - r.firstAt > RETRY.windowMs);
}

async function cancelStop(live, p, symbol) {
  if (!live || !p.stopOrderId) return { stopCancelled: null };
  try { await live.client.cancelOrder(p.stopOrderId, symbol); return { stopCancelled: true }; }
  catch (e) {
    if (isOrderNotFound(e)) return { stopCancelled: true };
    return { stopCancelled: false, stopError: errMsg(e), stopOrderId: p.stopOrderId };
  }
}

// Ejecuta (o simula) el cierre de UNA posición. Solo toca p.closePending; quitar la posición es cosa de closePosition.
// deps: { mode, live:{ex,client}|null, persist:async()=>void, now?:()=>number }
// Devuelve { status:'done'|'dust'|'failed', ... }
export async function executeClose({ p, uid, symbol, signalId, deps }) {
  const { mode, live, persist, now = Date.now } = deps;
  if (mode === 'live' && !live) return markCloseFailed(p, signalId, 'sin cliente de exchange en modo live: no se simula un cierre', now);   // nunca "cerrar" en paper por error
  const isLive = mode === 'live' && live;

  let plan;
  try {
    const rules = isLive ? await live.ex.amountRules(live.client, symbol) : {};
    plan = planClose(p.amount, rules);
  } catch (e) {
    return markCloseFailed(p, signalId, 'rules: ' + errMsg(e), now);
  }

  if (!plan.ok && plan.reason === 'no_amount') return markCloseFailed(p, signalId, 'invalid_amount: la cantidad guardada de la posición no es válida (' + p.amount + '); no se libera, revisar a mano', now);
  if (!plan.ok) {   // polvo bajo el mínimo del par: ver decisión en la cabecera
    delete p.closePending;
    return { status: 'dust', reason: plan.reason, amount: p.amount, ...(await cancelStop(isLive ? live : null, p, symbol)) };
  }

  if (!isLive) { delete p.closePending; return { status: 'done', via: 'paper', qty: plan.qty, residual: plan.residual, closedUsd: p.amountUsd || 0, stopCancelled: null }; }

  const orderId = closeOrderId(uid, p);
  const prev = p.closePending;
  p.closePending = { signalId: (prev && prev.signalId) ?? signalId, orderId, tries: prev ? prev.tries : 0, firstAt: prev && prev.tries > 0 ? prev.firstAt : now(), lastAt: now() };
  try { await persist(); }   // intención guardada ANTES de enviar; si no se puede guardar, no se envía
  catch (e) { return markCloseFailed(p, signalId, 'persist: ' + errMsg(e), now); }

  let via = 'order';
  try {
    await live.ex.placeOrder(live.client, { symbol, side: p.side === 'long' ? 'sell' : 'buy', amount: plan.qty, type: 'market', clientOrderId: orderId, params: { reduceOnly: true } });
  } catch (e) {
    if (!isDuplicateError(e)) return markCloseFailed(p, signalId, e, now);
    via = 'duplicate';   // ya se envió en un intento anterior: se da por hecho
  }

  delete p.closePending;
  const stop = await cancelStop(live, p, symbol);   // solo tras confirmar el cierre
  return { status: 'done', via, qty: plan.qty, residual: plan.residual, closedUsd: p.amountUsd || 0, ...stop };
}

// Cierra una posición dentro de su lista. Solo sale de la lista si el cierre se confirma
// (done) o si es polvo irrecuperable (dust). Si falla, la lista no cambia.
export async function closePosition({ list, p, uid, symbol, signalId, deps }) {
  const result = await executeClose({ p, uid, symbol, signalId, deps });
  const gone = result.status === 'done' || result.status === 'dust';
  return { list: gone ? list.filter(x => x !== p) : list, result };
}
