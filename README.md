# StayLiquid Engine — Fase 1 (Bot BTC)

Motor de ejecución automática para que el bot BTC opere en la cuenta de cada cliente,
24/7, **sin que StayLiquid custodie su dinero**. Esta Fase 1 trae:

- **Vault** con cifrado por sobres (envelope encryption) para las claves API.
- **Adaptador de exchange** (ccxt) con verificación de **"sin permiso de retirada"** (fallo seguro).
- **Ejecutor** en **modo paper** (simula y registra; no toca dinero) y el camino a modo **live**.
- **Sizing** con las reglas de cada cliente (importe por operación, exposición máxima).
- **Registro de órdenes** append-only y auditable.

> ⚠️ Antes de pasar a `live` con dinero real: revisión de seguridad del vault + KMS en producción + T&C revisados por un abogado (ver el documento de diseño, sección 9).

## Requisitos
- Node.js 20+.

## Arranque (modo paper, sin dinero)
```bash
cp .env.example .env
npm run keygen                 # copia el resultado en MASTER_KEY_B64 dentro de .env
npm install
npm run test:vault             # comprueba que el cifrado funciona
npm start                      # arranca el motor en modo paper leyendo signals.sample.json
```
Verás en consola las órdenes simuladas y se escribirán en `data/orders.log`.

## Formato de datos (`data/`)
- `clients.json` — clientes. En paper, `creds` puede ser `null` y se usa `paperBalanceUsd`.
  En live, `creds` es el objeto cifrado que devuelve `encryptSecret(JSON.stringify({apiKey, apiSecret}))`.
- `state.json` — última señal procesada + posiciones abiertas por cliente (lo gestiona el motor).
- `orders.log` — una línea JSON por orden. **Nunca** se escriben claves aquí.

Config por cliente (`cfg`):
```json
{ "mode": "fixed",   "amountUsd": 50, "maxExposureUsd": 150, "active": true }
{ "mode": "percent", "pct": 2,        "maxExposureUsd": 500, "active": true }
```

## Señales
`SIGNALS_URL` apunta a donde tu estrategia publica las señales. Formato:
```json
[{ "id": "sig-001", "symbol": "BTC/USDT", "side": "buy", "action": "open", "price": 71000 }]
```
`action`: `open` abre, `close` cierra. El motor procesa solo las **nuevas** (por `id`).

### Cierre seguro (`close.js`)
- Un fallo del exchange al cerrar **no se ignora**: la posición se queda en el estado del motor (con su stop en reposo) y se reintenta, máx. **3 intentos en 2 minutos**. Cada intento fallido se registra con `status: "error"` y el motivo (acotado a 300 caracteres). Agotados los reintentos, la posición **sigue abierta y gestionada** (`closePending` en el estado, log con `gaveUp: true`) y requiere intervención manual; una señal `close` nueva vuelve a intentarlo.
- Cantidad redondeada a la precisión del par y mínimos respetados (`amountRules`). **Polvo**: si la cantidad es 0 o queda bajo el mínimo del par, el exchange rechazaría cualquier orden; el motor no envía nada, **libera** la posición del estado y lo registra como `status: "skipped"`, `reason: "dust_below_min:…"` (con aviso en consola).
- Idempotente: `clientOrderId` determinista por posición (ligado a su orden de apertura) y la intención (`closePending`) se guarda **antes** de enviar. Si el exchange rechaza por duplicado se da por hecho (`via: "duplicate"` en el log).
- El stop en reposo (`stopOrderId`) se cancela **solo tras confirmar el cierre**. Si cancelarlo falla, el log lleva `stopCancelled: false` y hay aviso en consola (un stop `reduceOnly` huérfano podría tocar una posición futura: cancelarlo a mano).

## Pasar a modo live (cuando todo esté validado)
1. Despliega el vault con un **KMS** real (ver `src/vault.js` → `// >>> KMS`).
2. Alta de cliente: pega sus claves **solo-trading (sin retirada)** → `encryptSecret` → guárdalas en `clients.json`/BD.
3. Pon `EXEC_MODE=live`. El motor verifica cada clave con `verifyTradeOnly` y **rechaza** las que puedan retirar.
4. Empieza con límites bajos y pocas cuentas (la tuya primero).

## Seguridad — reglas que este código respeta
- Las claves se guardan **cifradas**; el registro guardable no contiene el secreto en claro.
- Las claves solo se descifran **en memoria** para firmar la orden; no se escriben en disco ni en logs.
- Se **rechaza** cualquier clave con permiso de retirada, o si no se puede verificar.
- Órdenes **idempotentes** (`clientOrderId = uid-signalId`): un reintento no duplica.
- Topes de exposición por cliente comprobados **antes** de cada orden.

## Despliegue sugerido
- Servicio always-on: Fly.io / Railway / Hetzner (el motor debe estar siempre encendido).
- BD: Supabase / Neon (Postgres) — sustituye `src/store.js`.
- KMS: AWS KMS / GCP KMS para la Master Key.
- Señales: tu `_worker.js` publica un JSON firmado que el motor lee.
