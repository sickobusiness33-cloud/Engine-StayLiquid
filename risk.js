// ============================================================================
// RISK · gestión de riesgo idéntica a la estrategia PRO Selectivo
// ----------------------------------------------------------------------------
// Parámetros (los mismos del backtest real):
//   S0  = 0.006  -> stop inicial 0.6%
//   ARM = 0.012  -> al ganar 1.2% a favor, el stop sube a break-even (entrada)
//   TR  = 0.02   -> una vez armado, trailing del 2% desde el pico
//
// Uso: por cada posición abierta, en cada tick llamas a updateStop(pos, price).
// Devuelve el nuevo stop y si hay que RE-colocar la orden en el exchange.
// ============================================================================
export const PARAMS = { S0: 0.006, ARM: 0.012, TR: 0.02 };

// pos: { side:'long'|'short', entry, peak, stop, armed }
// Devuelve pos mutada + { changed: bool }  (changed = el stop se movió)
export function updateStop(pos, price, p = PARAMS) {
  const long = pos.side === 'long';
  // inicializa en la primera llamada
  if (pos.stop == null) { pos.stop = long ? pos.entry * (1 - p.S0) : pos.entry * (1 + p.S0); pos.peak = pos.entry; pos.armed = false; }
  const prevStop = pos.stop;

  // actualiza el pico a favor
  pos.peak = long ? Math.max(pos.peak, price) : Math.min(pos.peak, price);

  // ¿llegó a armar break-even? (ganancia a favor >= ARM)
  const fav = long ? pos.peak / pos.entry - 1 : 1 - pos.peak / pos.entry;
  if (!pos.armed && fav >= p.ARM) { pos.armed = true; pos.stop = pos.entry; } // break-even

  // trailing una vez armado
  if (pos.armed) {
    const trail = long ? pos.peak * (1 - p.TR) : pos.peak * (1 + p.TR);
    pos.stop = long ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
  }

  const changed = Math.abs(pos.stop - prevStop) > prevStop * 1e-6;
  return { pos, changed };
}

// ¿el precio actual toca el stop? (por si lo gestionas tú en vez del exchange)
export function stopHit(pos, price) {
  if (pos.stop == null) return false;
  return pos.side === 'long' ? price <= pos.stop : price >= pos.stop;
}

// Coloca/actualiza la orden de stop en el exchange (cancel + replace).
// Requiere el adaptador de exchange (ccxt). Idempotente por stopOrderId.
export async function applyStopOrder(ex, client, pos, symbol) {
  const closeSide = pos.side === 'long' ? 'sell' : 'buy';
  try {
    if (pos.stopOrderId) { try { await client.cancelOrder(pos.stopOrderId, symbol); } catch (e) {} }
    // stop-market que cierra toda la posición al tocar el stop
    const order = await client.createOrder(symbol, 'market', closeSide, pos.amount, undefined, {
      stopPrice: pos.stop, reduceOnly: true, triggerPrice: pos.stop,
    });
    pos.stopOrderId = order.id;
    return { ok: true, id: order.id, stop: pos.stop };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}
