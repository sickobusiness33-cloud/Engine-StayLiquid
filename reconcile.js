// ============================================================================
// RECONCILE · mantiene el motor y el exchange siempre sincronizados
// ----------------------------------------------------------------------------
// En cada ciclo, por cada cliente en modo live:
//   1) Lee el precio actual y las posiciones reales del exchange.
//   2) Actualiza el trailing stop de cada posición (risk.updateStop) y, si el
//      stop se movió, re-coloca la orden de stop en el exchange.
//   3) Detecta posiciones que el exchange ya cerró (saltó el stop) y las quita.
//   4) Corrige desajustes (el motor cree tener algo que el exchange no tiene).
// En modo paper simula el trailing con el último precio conocido de la señal.
// ============================================================================
import { updateStop, applyStopOrder, stopHit } from './risk.js';

export async function reconcileClient({ mode, ex, client, uid, positions, lastPrice, symbol, log }) {
  const out = [];
  if (!positions || !positions.length) return out;

  // precio de referencia
  let price = lastPrice;
  if (mode === 'live' && client) {
    try { const t = await client.fetchTicker(symbol); price = t.last || t.close || price; } catch (e) {}
  }
  if (!(price > 0)) return out;

  for (const pos of positions) {
    const { changed } = updateStop(pos, price);

    if (mode === 'live' && client && changed) {
      const r = await applyStopOrder(ex, client, pos, symbol);
      log?.({ uid, event: 'stop-update', symbol, stop: pos.stop, ok: r.ok, reason: r.reason });
    }

    // en paper, cerramos nosotros si el precio toca el stop
    if (mode !== 'live' && stopHit(pos, price)) {
      pos._closed = true;
      log?.({ uid, event: 'paper-stop-hit', symbol, stop: pos.stop, price });
    }
  }

  // en live, comprueba qué sigue abierto de verdad
  if (mode === 'live' && client) {
    try {
      const real = await ex.openPositions(client, symbol);
      // real === null -> el exchange no pudo responder (error, límite de peticiones, sin fetchPositions): se DESCONOCE el estado.
      // Nunca se borra una posición por falta de datos: borrarla dejaría una posición abierta (o un cierre pendiente) sin control.
      if (real !== null) {
        const realOpen = real.some(p => Math.abs(Number(p.contracts || p.amount || 0)) > 0);
        if (!realOpen) { for (const pos of positions) if (pos.symbol === symbol) pos._closed = true; log?.({ uid, event: 'closed-on-exchange', symbol }); }   // solo las de ESTE símbolo
      }
    } catch (e) { log?.({ uid, event: 'reconcile-check-failed', symbol, reason: String((e && e.message) || e).slice(0, 200) }); }
  }

  return positions.filter(p => !p._closed);
}
