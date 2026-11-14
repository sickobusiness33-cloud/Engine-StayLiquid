// ============================================================================
// STORE · persistencia. Usa SUPABASE si está configurado (SUPABASE_URL +
// SUPABASE_SERVICE_KEY); si no, cae a archivos JSON locales (./data).
// ----------------------------------------------------------------------------
// Tablas en Supabase (crear con el SQL del README):
//   engine_kv     -> { k text PK, v jsonb, updated_at }   (clients, state, strategy)
//   engine_orders -> { id bigserial, at timestamptz, data jsonb }  (log de órdenes)
//
// Todas las funciones son ASYNC (Supabase es por red). Los secretos nunca se
// escriben en el log; las claves de cliente ya van cifradas por el vault.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

// Acepta la URL base o la Data API URL (con /rest/v1): quitamos ese sufijo para no duplicarlo.
const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const USE_SB = !!(SB_URL && SB_KEY);
const DIR = process.env.DATA_DIR || './data';

// ---------- Supabase REST (PostgREST) ----------
const sbHeaders = extra => ({ apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json', ...extra });
// LECTURA: solo una fila que NO existe (lista vacía) devuelve el valor por defecto. Cualquier fallo (red, HTTP no-2xx,
// JSON ilegible) LANZA: devolver el valor por defecto haría creer al motor que no hay clientes ni posiciones y el
// siguiente saveState borraría el estado real. Los mensajes no incluyen URL, claves ni contenido de la respuesta.
async function kvGet(key, def) {
  let r;
  try { r = await fetch(`${SB_URL}/rest/v1/engine_kv?k=eq.${encodeURIComponent(key)}&select=v`, { headers: sbHeaders() }); }
  catch (e) { throw new Error(`no se pudo leer '${key}' de Supabase (red)`); }
  if (!r.ok) throw new Error(`no se pudo leer '${key}' de Supabase (HTTP ${r.status})`);
  let rows;
  try { rows = await r.json(); } catch (e) { throw new Error(`no se pudo leer '${key}' de Supabase (respuesta ilegible)`); }
  return Array.isArray(rows) && rows.length && rows[0].v != null ? rows[0].v : def;
}
// strict=true: si Supabase no confirma la escritura (red o HTTP no-2xx) LANZA, para que quien necesite
// la garantía «guardado antes de enviar la orden» (close.js) no envíe nada sin intención persistida.
async function kvSet(key, v, strict = false) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/engine_kv`, { method: 'POST', headers: sbHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ k: key, v, updated_at: new Date().toISOString() }]) });
    if (strict && !r.ok) throw new Error('supabase kvSet HTTP ' + r.status);
  } catch (e) { if (strict) throw new Error('no se pudo guardar el estado: ' + String(e.message || e).slice(0, 120)); }
}
async function orderInsert(entry) {
  try {
    await fetch(`${SB_URL}/rest/v1/engine_orders`, { method: 'POST', headers: sbHeaders({ prefer: 'return=minimal' }), body: JSON.stringify([{ at: new Date().toISOString(), data: entry }]) });
  } catch (e) {}
}

// ---------- fallback a archivos JSON ----------
const p = f => path.join(DIR, f);
const ensure = () => fs.mkdirSync(DIR, { recursive: true });
// Archivo inexistente (primer arranque) -> valor por defecto. Archivo corrupto/ilegible -> LANZA (y no se toca):
// el mensaje no cita el contenido (clients.json lleva credenciales cifradas).
const readJSON = (f, def) => {
  let txt;
  try { txt = fs.readFileSync(p(f), 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return def; throw new Error(`no se pudo leer ${f} (${(e && e.code) || 'error'})`); }
  try { return JSON.parse(txt); } catch (e) { throw new Error(`${f} está corrupto (JSON inválido); no se sobrescribe, revisarlo a mano`); }
};
const writeJSON = (f, v) => { ensure(); fs.writeFileSync(p(f), JSON.stringify(v, null, 2)); };

export const store = {
  backend: USE_SB ? 'supabase' : 'files',
  async clients() { return USE_SB ? await kvGet('clients', []) : readJSON('clients.json', []); },
  async saveClients(c) { if (USE_SB) await kvSet('clients', c); else writeJSON('clients.json', c); },
  async state() { return USE_SB ? await kvGet('state', { lastSignalId: null, positions: {} }) : readJSON('state.json', { lastSignalId: null, positions: {} }); },
  async saveState(s) { if (USE_SB) await kvSet('state', s); else writeJSON('state.json', s); },
  async saveStateStrict(s) { if (USE_SB) await kvSet('state', s, true); else writeJSON('state.json', s); },   // lanza si no se confirma la escritura
  // Documentos sueltos por clave (Solana Copy Bot en simulación: 'solbot:users', 'solbot:paper:<uid>'). Lecturas: lanzan si fallan.
  async kvGet(k, def) { return USE_SB ? await kvGet(k, def) : readJSON('kv-' + String(k).replace(/[^A-Za-z0-9_-]/g, '_') + '.json', def); },
  async kvSet(k, v) { if (USE_SB) await kvSet(k, v, true); else writeJSON('kv-' + String(k).replace(/[^A-Za-z0-9_-]/g, '_') + '.json', v); },
  async strategyState() { return USE_SB ? await kvGet('strategy', null) : readJSON('strategy.json', null); },
  async saveStrategyState(s) { if (USE_SB) await kvSet('strategy', s); else writeJSON('strategy.json', s); },
  // Nunca lanza: muchos llamantes no esperan (await) este log y un fallo aquí tumbaría el proceso (rechazo no capturado).
  async logOrder(entry) {
    try {
      if (USE_SB) await orderInsert(entry);
      else { ensure(); fs.appendFileSync(p('orders.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
    } catch (e) { console.error('log error:', String((e && e.message) || e).slice(0, 200)); }
  },
  // Ticket de soporte -> tabla support_tickets en Supabase (o archivo local).
  async insertTicket(t) {
    const row = { ...t, at: new Date().toISOString() };
    if (USE_SB) {
      try { const r = await fetch(`${SB_URL}/rest/v1/support_tickets`, { method: 'POST', headers: sbHeaders({ prefer: 'return=minimal' }), body: JSON.stringify([row]) }); return r.ok; } catch (e) { return false; }
    }
    try { ensure(); fs.appendFileSync(p('tickets.log'), JSON.stringify(row) + '\n'); return true; } catch (e) { return false; }
  },
  // Diagnóstico: escribe y lee una fila de prueba y devuelve el error real si falla.
  async selfTest() {
    if (!USE_SB) return { backend: 'files' };
    try {
      const w = await fetch(`${SB_URL}/rest/v1/engine_kv`, { method: 'POST', headers: sbHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ k: '__selftest', v: { t: Date.now() }, updated_at: new Date().toISOString() }]) });
      const writeErr = w.ok ? '' : (await w.text()).slice(0, 300);
      const r = await fetch(`${SB_URL}/rest/v1/engine_kv?k=eq.__selftest&select=v`, { headers: sbHeaders() });
      const rows = r.ok ? await r.json() : [];
      const readErr = r.ok ? '' : (await r.text()).slice(0, 300);
      return { backend: 'supabase', url: SB_URL, keyPrefix: SB_KEY.slice(0, 11), writeStatus: w.status, writeErr, readStatus: r.status, readErr, readBack: rows.length ? rows[0].v : null };
    } catch (e) { return { backend: 'supabase', error: String(e.message || e) }; }
  },
};
