// ============================================================================
// EXCHANGE · adaptador sobre ccxt (unifica Binance, Bybit, etc.)
// ----------------------------------------------------------------------------
// - verifyTradeOnly(): comprueba que la clave API del cliente NO puede retirar.
//   Si no se puede confirmar al 100%, se RECHAZA (fallo seguro).
// - placeOrder(): envia una orden con idempotencia (clientOrderId).
// - balance()/positions(): para calcular tamanos y reconciliar.
// ============================================================================
import ccxt from 'ccxt';

export function makeClient({ exchange, apiKey, apiSecret, password }) {
  const Ex = ccxt[exchange];
  if (!Ex) throw new Error('exchange no soportado: ' + exchange);
  return new Ex({ apiKey, secret: apiSecret, password, enableRateLimit: true, options: { adjustForTimeDifference: true } });
}

// Verifica que la clave es SOLO-TRADING (sin permiso de retirada).
// Devuelve { ok, canWithdraw, canTrade, reason }.
export async function verifyTradeOnly(client) {
  try {
    if (client.id === 'binance') {
      // Binance expone las restricciones de la API key:
      const r = await client.sapiGetAccountApiRestrictions();
      const canWithdraw = !!r.enableWithdrawals;
      const canTrade = !!r.enableSpotAndMarginTrading || !!r.enableFutures;
      return { ok: canTrade && !canWithdraw, canWithdraw, canTrade, reason: canWithdraw ? 'la clave TIENE permiso de retirada: rechazada' : (canTrade ? 'ok' : 'la clave no puede operar') };
    }
    if (client.id === 'bybit') {
      const r = await client.privateGetV5UserQueryApi();
      const p = (r && r.result) || {};
      const canWithdraw = String(JSON.stringify(p.permissions || {})).toLowerCase().includes('withdraw');
      return { ok: !canWithdraw, canWithdraw, canTrade: true, reason: canWithdraw ? 'la clave TIENE permiso de retirada: rechazada' : 'ok' };
    }
    // Exchange no cubierto por una comprobacion explicita -> fallo seguro.
    return { ok: false, canWithdraw: null, canTrade: null, reason: 'no se puede verificar el permiso de retirada en este exchange: rechazada por seguridad' };
  } catch (e) {
    return { ok: false, canWithdraw: null, canTrade: null, reason: 'error verificando permisos: ' + (e.message || e) };
  }
}

export async function balanceUSDT(client) {
  const b = await client.fetchBalance();
  return (b.total && (b.total.USDT || b.total.USD)) || 0;
}

// Envia una orden real. clientOrderId garantiza idempotencia (no duplica si hay reintento).
export async function placeOrder(client, { symbol, side, amount, type = 'market', price, clientOrderId, params = {} }) {
  const p = { ...params };
  if (clientOrderId) p.clientOrderId = clientOrderId;
  return client.createOrder(symbol, type, side, amount, price, p);
}

// Reglas de cantidad del par: redondeo a la precisión del exchange y cantidad mínima.
export async function amountRules(client, symbol) {
  if (!client.markets) await client.loadMarkets();
  const m = client.market(symbol);
  const min = Number(m && m.limits && m.limits.amount && m.limits.amount.min) || 0;
  return { min, round: x => Number(client.amountToPrecision(symbol, x)) };
}

export async function openPositions(client, symbol) {
  if (typeof client.fetchPositions === 'function') { try { return await client.fetchPositions(symbol ? [symbol] : undefined); } catch (e) {} }
  return [];
}
