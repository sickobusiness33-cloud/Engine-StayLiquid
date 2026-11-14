# StayLiquid Engine — memoria de proyecto

Motor de ejecución que envía órdenes REALES de BTC en las cuentas de los clientes (ccxt). Node >=20, ESM, sin build.
Ramas: `version-victor` (trabajo) y `main`. El dueño ordenó expresamente (2026-11-14) integrar `version-victor` en `main` (avance sin conflictos desde `2f4419d`); a partir de ahí `main` lleva el cierre seguro. No empujar a `main` sin orden expresa del dueño, y nunca con force. Tests: `npm test` (node:test, `test/*.test.js`).

## Cómo quiere el dueño que se trabaje
- Responder en español, directo, sin rodeos. Resumen final de ~5 líneas: lo decidido, lo pendiente y qué skills/agentes se usaron DE VERDAD.
- Usar las skills/agentes/hooks de ECC que apliquen (no todas: solo las relevantes) y empezar con un informe breve: PROYECTO, TIPO DE TAREA, SKILLS/AGENTES/WORKFLOWS/MCP recomendados, MOTIVO.
- Flujo: Research → Plan → Implement → Test → Review → Verify. TDD: test que falla primero (RED), luego el mínimo código (GREEN).
- Antes de dar nada por terminado: revisión de código (`code-reviewer`), de seguridad (`security-reviewer`) y de fallos silenciosos (`silent-failure-hunter`); arreglar lo CRITICAL/HIGH.
- Bot BTC: todo es modo paper (sin pruebas contra un exchange real; un exchange simulado NO es evidencia de comportamiento real). Decirlo siempre claramente. ATENCIÓN: el Copy Bot de Solana (sección siguiente) mueve DINERO REAL en mainnet cuando `SOLBOT_LIVE=on`; nunca se ha ejecutado un swap real ni una transferencia real de retiro.
- Nunca poner secretos/claves en código, logs ni estado. No inventar cifras de rendimiento.
- Commits y comentarios sin nombre de ningún modelo de IA. Commitear y subir a `origin/version-victor` cuando se pida.

## Arquitectura (lo esencial)
- `engine.js` bucle: señales → `processSignal` (open/close/reduce) → `retryCloses`/`retryReduces` → `reconcileAll` (no en modo STRATEGY).
- `partial.js` (corte parcial `reduce`) y `close.js` (cierre total) comparten el patrón: error del exchange nunca se traga, posición se mantiene hasta confirmar, reintento acotado (`RETRY` = 3 intentos / 2 min), `clientOrderId` determinista, intención guardada ANTES de enviar, duplicado = hecho.
- `exchange.js` adaptador ccxt (`placeOrder`, `amountRules`); `risk.js` stop/trailing (`applyStopOrder`); `reconcile.js` sincroniza con el exchange.
- `engine.js` arranca el bucle al importarse: la lógica testeable vive en módulos (`close.js`, `partial.js`); probar el cableado con una copia y un `exchange.js` simulado.

## Decisiones y lecciones
- Cierre (`close.js`): el stop en reposo se cancela SOLO tras confirmar el cierre; si el cierre falla el stop sigue protegiendo. Polvo bajo el mínimo del par: se libera con log `skipped` + aviso (decisión documentada en README), nunca en silencio.
- El `clientOrderId` del cierre se ancla a `p.clientOrderId` (único por apertura), NO a `posId || symbol`: reabrir el mismo símbolo heredaría un id viejo y el exchange diría «duplicado» sin haber cerrado nada.
- Un cierre que no llega ni a intentarse (clave rechazada, red) también marca `closePending` para reintentar; si no, la señal se consume y la posición queda huérfana.
- No hacer depender un cierre de la consulta de saldo.
- «Intención guardada antes de enviar» exige `store.saveStateStrict` (lanza si Supabase no confirma). `saveState` normal traga errores de red. `logOrder` nunca lanza (muchos llamantes no lo esperan).
- Lecturas de `store`: solo «no existe» (fila vacía / ENOENT) devuelve el valor por defecto; cualquier fallo LANZA y no se sobrescribe nada (`state.json` corrupto = el motor se queda avisando, no borra posiciones). Los mensajes no citan contenido ni claves. `api.js` envuelve el handler: error de almacenamiento = 503, el servidor sigue vivo.
- `reconcile`: `openPositions` devuelve `null` si no se puede saber; null ≠ «no hay posiciones» (antes borraba todas las posiciones ante un error o en spot).

## Pendiente conocido (no resuelto; salió de las revisiones de código, seguridad y fallos silenciosos)
CRÍTICO/ALTO (fuera del alcance del cambio de cierre, a abordar pronto):
- Un error `duplicate` del exchange se da por «cierre hecho» (decisión pedida por el dueño). Riesgo: un id consumido por una orden rechazada daría un falso «hecho». Falta confirmar con `fetchOrder`/posición real (específico de cada exchange; no se puede probar sin exchange real).
- Stop `reduceOnly` huérfano (cancelación fallida tras cerrar, o `applyStopOrder` en `risk.js` que traga el error de cancelar y crea otro): solo se avisa por log; falta lista persistida y reintento.
- Señales repetidas: si `lastSignalId` no está en el feed se reprocesa todo y un `close` sin `posId` podría cerrar una posición nueva del mismo símbolo. Exigir `posId` en `close` y guardar los ids ya procesados.
- Clientes inactivos: sus señales y reintentos de cierre se saltan sin log (una posición abierta de un cliente pausado no se cierra).
MEDIO:
- Presupuesto de reintentos casi instantáneo (POLL 5 s = minGap 5 s → 3 intentos en ~10 s). Valorar backoff dentro de los 2 min y re-alerta mientras siga agotado.
- Polvo: se decide con `p.amount` del motor, no con la posición real del exchange. En modo STRATEGY no corre `reconcileAll`, así que no hay stop ni limpieza «closed-on-exchange».
- Cierre tras un `reduce` en vuelo (`preCutInFlight`) usa la cantidad previa al corte.
- `reduceOrderId` usa `posId || symbol` (mismo riesgo de colisión que se evitó en el cierre). `open` no redondea el tamaño a la precisión del exchange.
- `engine.js` no es testeable en unidad (arranca el bucle al importarse): sacar `main()` a una guarda `if (import.meta.url…)`.
Sin pruebas contra un exchange real ni testnet: todo verificado solo con simulaciones.

## Copy Bot de Solana (simulación y DINERO REAL) — añadido 2026-11-14
Cada usuario tiene una wallet de bot (clave cifrada con el vault, en `solbot:botwallets`) que se fondea a mano; el motor copia con ella, 24/7, los swaps nuevos del bot StayLiquid (`/api/copy/feed`) vía Jupiter. La wallet personal del usuario nunca se toca. Es CUSTODIA OPERATIVA de los fondos de esa wallet: la web lo dice (términos, pie, página Auto Copy).
- Módulos: `solwallet.js` (claves, cadena, transferencias, verificación de la firma de autorización), `jupiter.js` (order → firmar → execute; solo firma si el bot es la única firmante y la pagadora), `sollive.js` (ciclo real, ventas pendientes, retiro), `solapi.js` (rutas `/api/solbot/*`), `solbot.js` (simulación). Bucle PROPIO en `engine.js`: un swap lento nunca retrasa al bot BTC.
- INTERRUPTOR: `SOLBOT_LIVE=on` en Railway activa el dinero real. Apagado, las wallets y ajustes se guardan pero no se opera. Recomendado: `SOLANA_RPC_URL` de pago (el público se limita), `JUPITER_API_KEY`, `JUP_REFERRAL_ACCOUNT` + `SOLBOT_FEE_BPS` (110) para la comisión. `SOLBOT_MAX_PRICE_DEV` (0.25) = no comprar si el precio ya está >25% por encima del bot origen.
- Reglas que NO romper: intención guardada ANTES de mover dinero (`persist`); una operación por usuario a la vez (`withUserLock`); las ventas nunca se pierden (`live.pending`, 12 intentos/30 min); el destino del retiro es SIEMPRE `payoutWallet` y cambiarla tarda 24 h (`PAYOUT_DELAY_MS`); desconectar NO borra la wallet del bot; ningún error con URL/clave sin pasar por `scrub()`; topes duros `LIVE_LIMITS` (1 SOL/operación, 5 SOL abiertos).
- SIN VERIFICAR: ningún swap real en mainnet, ninguna transferencia de retiro enviada a la red (el grifo de devnet está cerrado), ni con Jupiter con fondos reales. Lo probado: claves, firmas y transacciones reales con red/Jupiter simulados, lecturas reales de mainnet y una transacción real de Jupiter (solo parseo). PRIMERA PRUEBA OBLIGATORIA antes de abrirlo a usuarios: wallet propia con ~0,05 SOL, un swap pequeño y un retiro.
- Tests: `npm test` (98).
