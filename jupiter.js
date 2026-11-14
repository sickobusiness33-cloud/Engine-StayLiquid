// ============================================================================
// JUPITER · swaps reales desde la wallet del bot (Swap API V2: /order -> firmar -> /execute)
// ----------------------------------------------------------------------------
// Mismas llamadas que usa la web (worker). Aquí se firma con la clave del bot, SOLO si la transacción devuelta por Jupiter
// tiene a la wallet del bot como única firmante requerida y como pagadora de comisiones (nunca firma otra cosa).
// ============================================================================
import { VersionedTransaction } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const base = () => process.env.JUPITER_BASE || 'https://api.jup.ag/swap/v2';
const headers = () => ({ accept: 'application/json', ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}) });
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// Cotización + transacción sin firmar. Devuelve el objeto de Jupiter o lanza con un motivo legible.
export async function getOrder({ inputMint, outputMint, amount, taker, slippageBps, feeBps, referral }, f = fetch) {
  const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker });
  if (slippageBps) q.set('slippageBps', String(slippageBps));
  if (referral && feeBps) { q.set('referralAccount', referral); q.set('referralFee', String(feeBps)); }
  let r, j;
  try { r = await f(base() + '/order?' + q, { headers: headers(), signal: AbortSignal.timeout(20000) }); j = await r.json(); }
  catch (e) { throw new Error('Jupiter no respondió'); }
  if (!r.ok) throw new Error('Jupiter rechazó la cotización: ' + String((j && (j.error || j.errorMessage)) || r.status).slice(0, 160));
  if (!j || !j.transaction) throw new Error('sin ruta o saldo insuficiente: ' + String((j && (j.errorMessage || j.error)) || 'Jupiter no devolvió transacción').slice(0, 160));
  if (String(j.inAmount) !== String(amount)) throw new Error('Jupiter devolvió una cotización que no coincide con lo pedido');
  if (j.inputMint && j.inputMint !== inputMint || j.outputMint && j.outputMint !== outputMint) throw new Error('Jupiter devolvió otro par de tokens');
  if (j.taker && j.taker !== taker) throw new Error('Jupiter devolvió otra wallet');
  return j;
}

// Firma la transacción de Jupiter con la clave del bot, tras comprobar que solo la necesita a ella como firmante y pagadora.
export function signOrderTx(txBase64, kp) {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error('la transacción pide más de una firma: no se firma');
  if (!tx.message.staticAccountKeys[0].equals(kp.publicKey)) throw new Error('la pagadora de la transacción no es la wallet del bot: no se firma');
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// Envía la transacción firmada. status: 'Success' | 'Failed' | 'Unknown' (no se sabe si se ejecutó).
export async function execute({ signedTransaction, requestId }, f = fetch) {
  let r, j = {};
  try { r = await f(base() + '/execute', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction, requestId }), signal: AbortSignal.timeout(60000) }); j = await r.json().catch(() => ({})); }
  catch (e) { return { status: 'Unknown', signature: null, error: 'sin respuesta de Jupiter' }; }
  const signature = SIG_RE.test(j.signature || '') ? j.signature : null;
  if (r.status === 429) return { status: 'Failed', signature: null, error: 'límite de peticiones de Jupiter' };
  const status = j.status === 'Success' ? 'Success' : (j.status === 'Failed' || r.status >= 400) ? 'Failed' : 'Unknown';
  return { status, signature, error: j.error ? String(j.error).slice(0, 200) : null, totalInputAmount: j.totalInputAmount ?? null, totalOutputAmount: j.totalOutputAmount ?? null };
}
