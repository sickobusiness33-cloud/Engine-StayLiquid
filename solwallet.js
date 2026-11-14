// ============================================================================
// SOLWALLET · wallets de bot por usuario (Copy Bot de Solana con dinero REAL)
// ----------------------------------------------------------------------------
// Modelo: la wallet personal del usuario NUNCA se toca. StayLiquid crea una wallet DEDICADA al bot para cada usuario; el usuario
// la fondea con los SOL que quiera poner a trabajar y el motor opera solo con ella. La clave privada de esa wallet se guarda
// CIFRADA (vault, AES-256-GCM con envelope) y solo se descifra en memoria para firmar. El usuario puede retirar todo a su wallet
// verificada en cualquier momento. Esto es custodia operativa de los fondos de la wallet del bot: se avisa claramente en la web.
// ============================================================================
import crypto from 'node:crypto';
import { Keypair, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { encryptSecret, decryptSecret } from './vault.js';

// Quita URLs (el RPC de pago lleva la clave dentro de la URL) de cualquier mensaje de error antes de guardarlo, registrarlo o enseñarlo.
export const scrub = (m, n = 160) => String((m && m.message) || m || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/[A-Za-z0-9_-]{40,}/g, '[…]').slice(0, n);

export const RESERVE_LAMPORTS = 10_000_000;   // 0.01 SOL siempre queda para comisiones de red / rent / cuentas de token
export const TRANSFER_FEE_LAMPORTS = 5000;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---------- claves ----------
export function newBotWallet() {
  const kp = Keypair.generate();
  return { pub: kp.publicKey.toBase58(), secretEnc: encryptSecret(Buffer.from(kp.secretKey).toString('base64')), createdAt: Date.now() };
}
export function loadBotKeypair(rec) {
  if (!rec || !rec.secretEnc || !rec.pub) throw new Error('wallet del bot no encontrada');
  const kp = Keypair.fromSecretKey(new Uint8Array(Buffer.from(decryptSecret(rec.secretEnc), 'base64')));
  if (kp.publicKey.toBase58() !== rec.pub) throw new Error('integridad de la wallet del bot: la clave no coincide con su dirección');
  return kp;
}

// ---------- blockchain ----------
export const getConn = (url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com') => new Connection(url, 'confirmed');
export async function solBalance(conn, pub) { return BigInt(await conn.getBalance(new PublicKey(pub), 'confirmed')); }
export async function mintDecimals(conn, mint) {
  const a = await conn.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const d = a && a.value && a.value.data && a.value.data.parsed && a.value.data.parsed.info && a.value.data.parsed.info.decimals;
  if (!Number.isInteger(d)) throw new Error('no se pudieron leer los decimales del token');
  return d;
}
const parseTokenAccts = res => res.value.map(a => { const i = a.account.data.parsed.info; return { mint: i.mint, raw: BigInt(i.tokenAmount.amount), decimals: i.tokenAmount.decimals }; });
export async function tokenBalance(conn, owner, mint) {
  const o = new PublicKey(owner), m = new PublicKey(mint);
  const res = await conn.getParsedTokenAccountsByOwner(o, { mint: m }, 'confirmed');
  const list = parseTokenAccts(res); return { raw: list.reduce((a, t) => a + t.raw, 0n), decimals: list[0] ? list[0].decimals : null };
}
export async function allTokens(conn, owner) {
  const o = new PublicKey(owner), out = [];
  for (const pid of [TOKEN_PROGRAM, TOKEN_2022]) out.push(...parseTokenAccts(await conn.getParsedTokenAccountsByOwner(o, { programId: new PublicKey(pid) }, 'confirmed')));
  const byMint = new Map(); for (const t of out) { const c = byMint.get(t.mint); if (c) c.raw += t.raw; else byMint.set(t.mint, { ...t }); }
  return [...byMint.values()].filter(t => t.raw > 0n);
}
// Transferencia de SOL desde la wallet del bot. Lanza si la red la rechaza o no se confirma.
export async function transferSol(conn, kp, to, lamports) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports: Number(lamports) }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = kp.publicKey; tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (c.value && c.value.err) throw new Error('la transferencia fue rechazada por la red');
  return sig;
}

// ---------- autorización firmada por el usuario ----------
export function consentMessage({ botPub, wallet, ts }) {
  return [
    'StayLiquid Auto Copy — authorization', '',
    'I authorize StayLiquid to trade automatically, 24/7, using my StayLiquid bot wallet, copying the StayLiquid bot\'s trades.', '',
    'Bot wallet: ' + botPub, 'My wallet: ' + wallet, 'Issued: ' + new Date(ts).toISOString(), '',
    'I understand that: the bot wallet is controlled by StayLiquid\'s servers and only holds the funds I choose to send to it;',
    'trading memecoins can lose all of those funds; I can pause the bot or withdraw everything to my own wallet at any time;',
    'StayLiquid will never ask for my seed phrase or private key.',
  ].join('\n');
}
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function verifySignature(pubB58, message, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(new PublicKey(pubB58).toBytes())]), format: 'der', type: 'spki' });
    const sig = Buffer.from(String(sigB64 || ''), 'base64');
    return sig.length === 64 && crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch (e) { return false; }
}
export const CONSENT_MAX_AGE_MS = 15 * 60 * 1000;
export function checkConsent({ botPub, wallet, ts, signature, now = Date.now() }) {
  const t = Number(ts);
  if (!Number.isFinite(t) || now - t > CONSENT_MAX_AGE_MS || t - now > 60_000) return { ok: false, reason: 'la autorización caducó; vuelve a firmar' };
  if (!verifySignature(wallet, consentMessage({ botPub, wallet, ts: t }), signature)) return { ok: false, reason: 'la firma no es válida para esta wallet' };
  return { ok: true };
}
