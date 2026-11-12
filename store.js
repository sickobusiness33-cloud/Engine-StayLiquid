// ============================================================================
// STORE · persistencia (Fase 1: archivos JSON en ./data).
// En produccion: sustituir por Postgres (Supabase/Neon). La interfaz es la misma.
// ----------------------------------------------------------------------------
//   clients.json  -> [{ uid, exchange, creds(cifradas), cfg, active }]
//   state.json    -> { lastSignalId, positions: { uid: [...] } }
//   orders.log    -> una linea JSON por orden (append-only, auditable)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';
const p = f => path.join(DIR, f);
function ensure() { fs.mkdirSync(DIR, { recursive: true }); }
function readJSON(f, def) { try { return JSON.parse(fs.readFileSync(p(f), 'utf8')); } catch (e) { return def; } }
function writeJSON(f, v) { ensure(); fs.writeFileSync(p(f), JSON.stringify(v, null, 2)); }

export const store = {
  clients() { return readJSON('clients.json', []); },
  saveClients(c) { writeJSON('clients.json', c); },
  state() { return readJSON('state.json', { lastSignalId: null, positions: {} }); },
  saveState(s) { writeJSON('state.json', s); },
  strategyState() { return readJSON('strategy.json', null); },
  saveStrategyState(s) { writeJSON('strategy.json', s); },
  // Registro de ordenes: append-only. NUNCA se escriben claves ni secretos aqui.
  logOrder(entry) { ensure(); fs.appendFileSync(p('orders.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); },
};
