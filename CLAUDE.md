# StayLiquid Engine — memoria de proyecto

Motor de ejecución que envía órdenes REALES de BTC en las cuentas de los clientes (ccxt). Node >=20, ESM, sin build.
Ramas: `version-victor` (trabajo) y `main`. El dueño ordenó expresamente (2026-11-14) integrar `version-victor` en `main` (avance sin conflictos desde `2f4419d`); a partir de ahí `main` lleva el cierre seguro. No empujar a `main` sin orden expresa del dueño, y nunca con force. Tests: `npm test` (node:test, `test/*.test.js`).

## Cómo quiere el dueño que se trabaje
- Responder en español, directo, sin rodeos. Resumen final de ~5 líneas: lo decidido, lo pendiente y qué skills/agentes se usaron DE VERDAD.
- Usar las skills/agentes/hooks de ECC que apliquen (no todas: solo las relevantes) y empezar con un informe breve: PROYECTO, TIPO DE TAREA, SKILLS/AGENTES/WORKFLOWS/MCP recomendados, MOTIVO.
- Flujo: Research → Plan → Implement → Test → Review → Verify. TDD: test que falla primero (RED), luego el mínimo código (GREEN).
- Antes de dar nada por terminado: revisión de código (`code-reviewer`), de seguridad (`security-reviewer`) y de fallos silenciosos (`silent-failure-hunter`); arreglar lo CRITICAL/HIGH.
- Todo es modo paper: no hay pruebas contra un exchange real. Decirlo siempre claramente; un exchange simulado NO es evidencia de comportamiento real.
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
- `reconcile`: `openPositions` devuelve `null` si no se puede saber; null ≠ «no hay posiciones» (antes borraba todas las posiciones ante un error o en spot).

## Pendiente conocido (no resuelto; salió de las revisiones de código, seguridad y fallos silenciosos)
CRÍTICO/ALTO (fuera del alcance del cambio de cierre, a abordar pronto):
- `store.js`: `kvGet`/`readJSON` devuelven el valor por defecto si la lectura falla; el siguiente `saveState` puede borrar todas las posiciones. Hay que lanzar en lectura, pero `api.js` no tiene `try/catch` global en su handler (un throw tumbaría el servidor): endurecer ambos a la vez. `saveStateStrict` ya existe y lo usa el cierre.
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
