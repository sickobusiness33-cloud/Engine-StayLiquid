// ============================================================================
// VAULT · cifrado de secretos por sobres (envelope encryption)
// ----------------------------------------------------------------------------
// Objetivo: guardar las claves API del cliente de forma que, aunque alguien
// robe la base de datos, no pueda leerlas sin la Master Key.
//
// Esquema:
//   1) Por cada secreto se genera una DATA KEY aleatoria (32 bytes).
//   2) El secreto se cifra con la data key  -> AES-256-GCM.
//   3) La data key se "envuelve" (wrap) con la MASTER KEY -> AES-256-GCM.
//   4) En la base de datos se guarda SOLO: {ciphertext, iv, tag, dk, dkIv, dkTag}.
//      Nada legible. La Master Key nunca se guarda con los datos.
//
// Fase 1: la Master Key vive en una variable de entorno (MASTER_KEY_B64).
// Produccion: sustituye wrapDataKey/unwrapDataKey por llamadas a un KMS
// (AWS KMS / GCP KMS) para que la Master Key NUNCA exista en tu proceso.
// Marcado abajo con  // >>> KMS
// ============================================================================
import crypto from 'node:crypto';

const ALG = 'aes-256-gcm';

function masterKey() {
  const b64 = process.env.MASTER_KEY_B64;
  if (!b64) throw new Error('Falta MASTER_KEY_B64 (genera una con: npm run keygen)');
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('MASTER_KEY_B64 debe ser 32 bytes en base64');
  return k;
}

function aesEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return { ct, iv, tag: c.getAuthTag() };
}

function aesDecrypt(key, ct, iv, tag) {
  const d = crypto.createDecipheriv(ALG, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// >>> KMS: en produccion, estas dos funciones llaman al KMS en vez de usar
// una master key local. El KMS descifra la data key sin exponer la master key.
function wrapDataKey(dataKey) { const { ct, iv, tag } = aesEncrypt(masterKey(), dataKey.toString('base64')); return { dk: ct, dkIv: iv, dkTag: tag }; }
function unwrapDataKey(dk, dkIv, dkTag) { return Buffer.from(aesDecrypt(masterKey(), dk, dkIv, dkTag), 'base64'); }

const b64 = b => b.toString('base64');
const buf = s => Buffer.from(s, 'base64');

// Cifra un secreto (string). Devuelve un registro 100% guardable en BD.
export function encryptSecret(plaintext) {
  const dataKey = crypto.randomBytes(32);
  const { ct, iv, tag } = aesEncrypt(dataKey, plaintext);
  const w = wrapDataKey(dataKey);
  dataKey.fill(0); // borra la data key de memoria
  return { v: 1, ct: b64(ct), iv: b64(iv), tag: b64(tag), dk: b64(w.dk), dkIv: b64(w.dkIv), dkTag: b64(w.dkTag) };
}

// Descifra un registro. Devuelve el secreto en claro (usalo y descartalo; no lo guardes ni lo loguees).
export function decryptSecret(rec) {
  if (!rec || rec.v !== 1) throw new Error('registro de secreto invalido');
  const dataKey = unwrapDataKey(buf(rec.dk), buf(rec.dkIv), buf(rec.dkTag));
  try { return aesDecrypt(dataKey, buf(rec.ct), buf(rec.iv), buf(rec.tag)); }
  finally { dataKey.fill(0); }
}

// Autotest: node src/vault.js --selftest
if (process.argv.includes('--selftest')) {
  if (!process.env.MASTER_KEY_B64) process.env.MASTER_KEY_B64 = crypto.randomBytes(32).toString('base64');
  const secreto = JSON.stringify({ apiKey: 'AK_demo_123', apiSecret: 'SECRET_demo_xyz' });
  const rec = encryptSecret(secreto);
  const back = decryptSecret(rec);
  const ok = back === secreto && !JSON.stringify(rec).includes('SECRET_demo_xyz');
  console.log('registro guardable:', JSON.stringify(rec).slice(0, 90) + '...');
  console.log('round-trip correcto:', back === secreto);
  console.log('el secreto NO aparece en claro en el registro:', !JSON.stringify(rec).includes('SECRET_demo_xyz'));
  console.log(ok ? 'VAULT OK' : 'VAULT FALLO'); process.exit(ok ? 0 : 1);
}
