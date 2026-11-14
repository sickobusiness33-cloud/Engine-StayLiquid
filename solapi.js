// ============================================================================
// SOLAPI · rutas del Copy Bot de Solana (simulación y dinero real). Las llama api.js tras validar el token del motor;
// el worker ya verificó el login, fijó el uid y comprobó que la wallet pertenece a la cuenta.
// Devuelven { code, body }. Nunca devuelven claves: las wallets de los bots viven en 'solbot:botwallets' y solo se leen para firmar.
// ============================================================================
import { isAddr, normalizeCfg, freshPaper, summary, FEE_BPS, SLIP_BPS } from './solbot.js';
import { scrub, newBotWallet, loadBotKeypair, consentMessage, checkConsent, solBalance, getConn } from './solwallet.js';
import { liveEnabled, LIVE_LIMITS, liveCfg, freshLive, withUserLock, withdrawAll } from './sollive.js';

export const isUid = u => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);        // 'uid' = '__proto__' no debe resolver al prototipo
const R = (code, body) => ({ code, body });
export const PAYOUT_DELAY_MS = 24 * 60 * 60 * 1000;   // cambiar la wallet de cobro tarda 24 h: quien robe una sesión no puede desviar los fondos al momento
// Activa el cambio de wallet de cobro pendiente cuando ya ha pasado el plazo. Devuelve true si cambió algo.
const activatePayout = (rec, t) => { if (rec.pendingPayout && t >= rec.pendingPayout.activateAt) { rec.payoutWallet = rec.pendingPayout.wallet; delete rec.pendingPayout; return true; } return false; };

export function makeSolApi({ store, getConnection = getConn, now = Date.now, swapDeps } = {}) {
  let lock = Promise.resolve();                                             // lecturas-modificaciones-escrituras en serie
  const withLock = fn => { const r = lock.then(fn, fn); lock = r.then(() => {}, () => {}); return r; };
  const balCache = new Map();
  async function balanceSol(pub) {
    const c = balCache.get(pub); if (c && now() - c.t < 15000) return c.v;
    const v = Number(await solBalance(getConnection(), pub)) / 1e9; balCache.set(pub, { t: now(), v }); return v;
  }

  async function view(uid, u) {
    if (u.mode === 'live') {
      const rec = own(await store.kvGet('solbot:botwallets', {}), uid), live = (await store.kvGet('solbot:live:' + uid, null)) || freshLive();
      let bal = null; try { if (rec) bal = await balanceSol(rec.pub); } catch (e) { /* RPC caído: se muestra sin saldo */ }
      return { connected: true, mode: 'live', active: !!u.active, wallet: u.wallet, cfg: u.cfg, since: u.since, botWallet: rec ? rec.pub : null, payoutWallet: rec ? rec.payoutWallet || null : null, pendingPayout: rec ? rec.pendingPayout || null : null, liveEnabled: liveEnabled(), limits: LIVE_LIMITS,
        balanceSol: bal, positions: Object.values(live.positions).map(p => ({ mint: p.mint, sym: p.sym, costSol: +p.costSol.toFixed(4) })), trades: live.trades.slice(0, 20) };
    }
    const paper = (await store.kvGet('solbot:paper:' + uid, null)) || freshPaper();
    return { connected: true, mode: 'paper', active: !!u.active, wallet: u.wallet, cfg: u.cfg, since: u.since, model: { feeBps: FEE_BPS, slippageBps: SLIP_BPS }, ...summary(paper) };
  }
  const walletInfo = async rec => {
    let bal = null; try { bal = await balanceSol(rec.pub); } catch (e) {}
    return { exists: true, pub: rec.pub, balanceSol: bal, payoutWallet: rec.payoutWallet || null, pendingPayout: rec.pendingPayout || null, liveEnabled: liveEnabled(), limits: LIVE_LIMITS };
  };

  async function get(path, q) {
    const uid = String(q.get('uid') || ''); if (!isUid(uid)) return R(400, { error: 'uid no valido' });
    if (path === '/api/solbot/status') { const u = own(await store.kvGet('solbot:users', {}), uid); return u ? R(200, await view(uid, u)) : R(404, { error: 'no conectado' }); }
    if (path === '/api/solbot/wallet') { const rec = own(await store.kvGet('solbot:botwallets', {}), uid); return R(200, rec ? await walletInfo(rec) : { exists: false, liveEnabled: liveEnabled(), limits: LIVE_LIMITS }); }
    if (path === '/api/solbot/consent') {
      const wallet = String(q.get('wallet') || ''), rec = own(await store.kvGet('solbot:botwallets', {}), uid);
      if (!isAddr(wallet)) return R(400, { error: 'wallet no valida' });
      if (!rec) return R(409, { error: 'primero crea la wallet del bot' });
      const ts = now(); return R(200, { botPub: rec.pub, ts, message: consentMessage({ botPub: rec.pub, wallet, ts }) });
    }
    return R(404, { error: 'no encontrado' });
  }

  async function post(path, body) {
    const uid = String(body.uid || '').trim(); if (!isUid(uid)) return R(400, { error: 'uid no valido' });

    if (path === '/api/solbot/wallet') {                                    // crea la wallet del bot (o devuelve la que ya tiene). Nunca se borra ni se regenera.
      return withLock(async () => {
        const wallets = await store.kvGet('solbot:botwallets', {}); let rec = own(wallets, uid);
        if (!rec) { rec = newBotWallet(); wallets[uid] = rec; await store.kvSet('solbot:botwallets', wallets); }
        return R(200, await walletInfo(rec));
      });
    }

    if (path === '/api/solbot/withdraw') {
      const rec = own(await store.kvGet('solbot:botwallets', {}), uid); if (!rec) return R(404, { error: 'no tienes wallet de bot' });
      let to; await withLock(async () => {                                  // 1) pausa el bot y fija el destino: SIEMPRE la wallet de cobro verificada (el cambio tarda 24 h), nunca una de la petición
        const wallets = await store.kvGet('solbot:botwallets', {}), r2 = own(wallets, uid) || rec;
        if (activatePayout(r2, now())) { wallets[uid] = r2; await store.kvSet('solbot:botwallets', wallets); }
        to = r2.payoutWallet;
        const users = await store.kvGet('solbot:users', {}), u = own(users, uid);
        if (u) { u.active = false; u.updatedAt = now(); await store.kvSet('solbot:users', users); }
      });
      if (!isAddr(to)) return R(409, { error: 'no hay una wallet verificada de destino' });
      try {
        const r = await withUserLock(uid, () => withdrawAll({ conn: getConnection(), kp: loadBotKeypair(rec), to, sellAll: body.sellAll === true, swapDeps }));
        balCache.delete(rec.pub); return R(200, { ok: true, to, ...r });
      } catch (e) { return R(502, { error: 'no se pudo completar el retiro: ' + scrub(e, 140) + '. Tus fondos siguen en la wallet del bot; reintenta.' }); }
    }

    return withLock(async () => {
      const users = await store.kvGet('solbot:users', {}), u = own(users, uid);
      if (path === '/api/solbot/connect') {
        if (!isAddr(body.wallet)) return R(400, { error: 'wallet no valida' });
        if (Object.entries(users).some(([k, v]) => k !== uid && v && v.wallet === body.wallet)) return R(409, { error: 'esa wallet ya esta conectada a otra cuenta' });
        const t = now();
        if (body.mode === 'live') {
          const wallets = await store.kvGet('solbot:botwallets', {}), rec = own(wallets, uid);
          if (!rec) return R(409, { error: 'primero crea la wallet del bot' });
          const chk = checkConsent({ botPub: rec.pub, wallet: body.wallet, ts: body.ts, signature: body.signature, now: t });
          if (!chk.ok) return R(400, { error: 'autorizacion no valida: ' + chk.reason });
          users[uid] = { wallet: body.wallet, cfg: liveCfg(body.cfg), active: true, mode: 'live', since: t, connectedAt: u ? u.connectedAt : t, updatedAt: t, consent: { ts: Number(body.ts), signature: String(body.signature) } };
          const nrec = { ...rec }; activatePayout(nrec, t);
          if (!nrec.payoutWallet) nrec.payoutWallet = body.wallet;                                   // primera vez: queda fijada
          else if (nrec.payoutWallet === body.wallet) delete nrec.pendingPayout;                      // volver a la de siempre cancela un cambio pendiente
          else if (!nrec.pendingPayout || nrec.pendingPayout.wallet !== body.wallet) nrec.pendingPayout = { wallet: body.wallet, activateAt: t + PAYOUT_DELAY_MS };   // otra wallet: cambio con retardo
          wallets[uid] = nrec;
          await store.kvSet('solbot:users', users); await store.kvSet('solbot:botwallets', wallets);
          return R(200, await view(uid, users[uid]));
        }
        users[uid] = { wallet: body.wallet, cfg: normalizeCfg(body.cfg), active: true, since: t, connectedAt: u ? u.connectedAt : t, updatedAt: t };
        await store.kvSet('solbot:users', users);
        if (!u || u.wallet !== body.wallet || u.mode === 'live') await store.kvSet('solbot:paper:' + uid, freshPaper());   // otra wallet = cuenta virtual nueva
        return R(200, await view(uid, users[uid]));
      }
      if (!u) return R(404, { error: 'no conectado' });
      if (path === '/api/solbot/config') {
        if (body.cfg) u.cfg = u.mode === 'live' ? liveCfg({ ...u.cfg, ...body.cfg }) : normalizeCfg({ ...u.cfg, ...body.cfg });
        if (typeof body.active === 'boolean') { if (body.active && !u.active) u.since = now(); u.active = body.active; }   // al reanudar no se copia lo que pasó en pausa
        u.updatedAt = now(); await store.kvSet('solbot:users', users); return R(200, await view(uid, u));
      }
      if (path === '/api/solbot/disconnect') {
        delete users[uid]; await store.kvSet('solbot:users', users);
        if (u.mode !== 'live') await store.kvSet('solbot:paper:' + uid, null);   // en real NO se borra nada: la wallet del bot y su historial se conservan para poder retirar los fondos
        return R(200, { ok: true, disconnected: true, keptBotWallet: u.mode === 'live' });
      }
      return R(404, { error: 'no encontrado' });
    });
  }
  return { get, post };
}
