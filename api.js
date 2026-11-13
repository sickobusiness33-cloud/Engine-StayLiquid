// ============================================================================
// API · servidor HTTP del motor (lo que usa el panel de conexión del frontend)
// ----------------------------------------------------------------------------
// Endpoints (JSON):
//   POST /api/bot/connect     { uid, exchange, apiKey, apiSecret, cfg }
//   POST /api/bot/config      { uid, cfg }
//   POST /api/bot/disconnect  { uid }
//   GET  /api/bot/status?uid=...
//
// Seguridad:
//   - Todas las llamadas requieren cabecera  Authorization: Bearer <token>.
//     Fase 1: el token es ENGINE_API_TOKEN (una clave compartida con el frontend).
//     Producción: verifica aquí el ID token de Firebase del usuario (// >>> AUTH).
//   - connect VERIFICA que la clave es solo-trading (sin retirada); si no, la rechaza.
//   - Las claves se guardan CIFRADAS (vault). El status NUNCA devuelve claves.
// ============================================================================
import http from 'node:http';
import { store } from './store.js';
import { encryptSecret } from './vault.js';
// ccxt se carga de forma perezosa solo al conectar una clave real (el modo paper no lo necesita).

const ALLOW_ORIGIN = process.env.CORS_ORIGIN || '*';

function send(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  // >>> AUTH: en producción, verifica aquí el ID token de Firebase y saca el uid de ahí.
  return !!process.env.ENGINE_API_TOKEN && token === process.env.ENGINE_API_TOKEN;
}

function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } }); });
}

const validCfg = c => c && (c.mode === 'fixed' ? Number(c.amountUsd) > 0 : Number(c.pct) > 0) && Number(c.maxExposureUsd) > 0;

export function startApi(port = Number(process.env.PORT || process.env.API_PORT || 8787)) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://x');

    // Salud pública (sin claves ni datos de clientes): para ver que el motor sigue al bot en vivo.
    if (req.method === 'GET' && url.pathname === '/api/bot/health') {
      let st = null; try { st = await store.strategyState(); } catch (e) {}
      const strategyOn = (process.env.STRATEGY || '').toLowerCase() === 'on' || (process.env.SIGNALS_URL || '') === 'strategy';
      return send(res, 200, {
        ok: true,
        backend: store.backend,
        mode: (process.env.EXEC_MODE || 'paper').toLowerCase(),
        strategy: strategyOn ? {
          active: true,
          warmed: !!(st && st.warmed),
          trend: st ? st.trend : 0,
          openPositions: st && st.open ? st.open.length : 0,
          lastBar: st && st.lastBarT ? new Date(st.lastBarT * 1000).toISOString() : null,
        } : { active: false },
        clients: (await store.clients()).length,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/bot/status') {
      if (!auth(req)) return send(res, 401, { error: 'no autorizado' });
      const uid = url.searchParams.get('uid');
      const c = (await store.clients()).find(x => x.uid === uid);
      if (!c) return send(res, 404, { error: 'no conectado' });
      const pos = ((await store.state()).positions[uid] || []);
      return send(res, 200, { connected: true, active: !!c.active, exchange: c.exchange, cfg: c.cfg, openPositions: pos.length }); // sin claves
    }

    if (req.method === 'POST') {
      if (!auth(req)) return send(res, 401, { error: 'no autorizado' });
      const body = await readBody(req);
      const uid = String(body.uid || '').trim();
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return send(res, 400, { error: 'uid no valido' });
      const clients = await store.clients();
      const idx = clients.findIndex(x => x.uid === uid);

      if (url.pathname === '/api/bot/connect') {
        if (!validCfg(body.cfg)) return send(res, 400, { error: 'configuracion no valida' });
        if (!body.apiKey || !body.apiSecret) return send(res, 400, { error: 'faltan las claves' });
        // 1) verifica que la clave NO puede retirar (fallo seguro)
        try {
          const { makeClient, verifyTradeOnly } = await import('./exchange.js');
          const client = makeClient({ exchange: body.exchange, apiKey: body.apiKey, apiSecret: body.apiSecret, password: body.password });
          const chk = await verifyTradeOnly(client);
          if (!chk.ok) return send(res, 400, { error: 'clave rechazada: ' + chk.reason });
        } catch (e) { return send(res, 400, { error: 'no se pudo validar la clave: ' + (e.message || e) }); }
        // 2) cifra y guarda (nunca en claro)
        const creds = encryptSecret(JSON.stringify({ apiKey: body.apiKey, apiSecret: body.apiSecret, password: body.password || undefined }));
        const rec = { uid, exchange: body.exchange, active: true, creds, cfg: { ...body.cfg, active: true } };
        if (idx >= 0) clients[idx] = rec; else clients.push(rec);
        await store.saveClients(clients);
        return send(res, 200, { ok: true, connected: true });
      }

      if (url.pathname === '/api/bot/config') {
        if (idx < 0) return send(res, 404, { error: 'no conectado' });
        if (!validCfg(body.cfg)) return send(res, 400, { error: 'configuracion no valida' });
        clients[idx].cfg = { ...clients[idx].cfg, ...body.cfg };
        if (typeof body.active === 'boolean') { clients[idx].active = body.active; clients[idx].cfg.active = body.active; }
        await store.saveClients(clients);
        return send(res, 200, { ok: true, cfg: clients[idx].cfg, active: clients[idx].active });
      }

      if (url.pathname === '/api/bot/disconnect') {
        if (idx < 0) return send(res, 200, { ok: true });
        clients.splice(idx, 1); await store.saveClients(clients);               // borra credenciales
        const st = await store.state(); delete st.positions[uid]; await store.saveState(st);
        return send(res, 200, { ok: true, disconnected: true });
      }
    }

    return send(res, 404, { error: 'no encontrado' });
  });
  server.listen(port, () => console.log('API del motor escuchando en :' + port));
  return server;
}
