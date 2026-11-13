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
async function kvGet(key, def) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/engine_kv?k=eq.${encodeURIComponent(key)}&select=v`, { headers: sbHeaders() });
    if (!r.ok) return def;
    const rows = await r.json();
    return rows.length && rows[0].v != null ? rows[0].v : def;
  } catch (e) { return def; }
}
async function kvSet(key, v) {
  try {
    await fetch(`${SB_URL}/rest/v1/engine_kv`, { method: 'POST', headers: sbHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ k: key, v, updated_at: new Date().toISOString() }]) });
  } catch (e) {}
}
async function orderInsert(entry) {
  try {
    await fetch(`${SB_URL}/rest/v1/engine_orders`, { method: 'POST', headers: sbHeaders({ prefer: 'return=minimal' }), body: JSON.stringify([{ at: new Date().toISOString(), data: entry }]) });
  } catch (e) {}
}

// ---------- fallback a archivos JSON ----------
const p = f => path.join(DIR, f);
const ensure = () => fs.mkdirSync(DIR, { recursive: true });
const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(p(f), 'utf8')); } catch (e) { return def; } };
const writeJSON = (f, v) => { ensure(); fs.writeFileSync(p(f), JSON.stringify(v, null, 2)); };

export const store = {
  backend: USE_SB ? 'supabase' : 'files',
  async clients() { return USE_SB ? await kvGet('clients', []) : readJSON('clients.json', []); },
  async saveClients(c) { if (USE_SB) await kvSet('clients', c); else writeJSON('clients.json', c); },
  async state() { return USE_SB ? await kvGet('state', { lastSignalId: null, positions: {} }) : readJSON('state.json', { lastSignalId: null, positions: {} }); },
  async saveState(s) { if (USE_SB) await kvSet('state', s); else writeJSON('state.json', s); },
  async strategyState() { return USE_SB ? await kvGet('strategy', null) : readJSON('strategy.json', null); },
  async saveStrategyState(s) { if (USE_SB) await kvSet('strategy', s); else writeJSON('strategy.json', s); },
  async logOrder(entry) {
    if (USE_SB) await orderInsert(entry);
    else { ensure(); fs.appendFileSync(p('orders.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
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
