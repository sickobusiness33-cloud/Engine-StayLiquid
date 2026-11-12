// ============================================================================
// SIZING · calcula el tamano de la orden con las reglas DEL CLIENTE, no del bot.
// ----------------------------------------------------------------------------
// Config del cliente (ejemplo):
//   { mode: 'fixed', amountUsd: 50, maxExposureUsd: 500 }
//   { mode: 'percent', pct: 2, maxExposureUsd: 500 }   // 2% del saldo por operacion
// Devuelve { amountUsd, blocked, reason }.
// ============================================================================
export function sizeForClient({ cfg, balanceUsd, openExposureUsd, signalPrice }) {
  if (!cfg || cfg.active === false) return { amountUsd: 0, blocked: true, reason: 'cliente inactivo' };

  let amountUsd = 0;
  if (cfg.mode === 'percent') amountUsd = (balanceUsd * (Number(cfg.pct) || 0)) / 100;
  else amountUsd = Number(cfg.amountUsd) || 0;

  if (!(amountUsd > 0)) return { amountUsd: 0, blocked: true, reason: 'importe por operacion no valido' };

  // Tope de exposicion: nunca superar maxExposureUsd sumando lo ya abierto.
  const max = Number(cfg.maxExposureUsd) || Infinity;
  if (openExposureUsd + amountUsd > max) {
    const libre = Math.max(0, max - openExposureUsd);
    if (libre <= 0) return { amountUsd: 0, blocked: true, reason: 'tope de exposicion alcanzado' };
    amountUsd = libre; // recorta a lo que quepa dentro del tope
  }

  // No arriesgar mas del saldo disponible.
  if (amountUsd > balanceUsd) amountUsd = balanceUsd;
  if (!(amountUsd > 0)) return { amountUsd: 0, blocked: true, reason: 'saldo insuficiente' };

  // Cantidad en el activo (p. ej. BTC) a partir del precio de referencia.
  const amountAsset = signalPrice > 0 ? amountUsd / signalPrice : 0;
  return { amountUsd, amountAsset, blocked: false, reason: 'ok' };
}
