# omp setup — fallback entre suscripciones (Claude ↔ Codex)

Esta carpeta conserva la configuración, utilidades e historial del espacio local
`omp setup`, incorporados al repositorio el 2026-09-25. Las rutas de Windows y los
roles son una configuración personal de referencia: adáptalos antes de aplicarlos.

Desde la raíz de un clon de desarrollo del plugin, con sus dependencias instaladas:

```bash
node setup/tests/run-unit.mjs .
bun setup/roles-report.ts --days 1
node setup/bridge-stats.mjs --days 1
```

Las once copias históricas de pruebas están conservadas en
[`archive/historical-tests.zip`](archive/historical-tests.zip), para evitar que se
descubran como pruebas activas con imports y fixtures antiguos. Las pruebas vigentes
del plugin están en [`../tests`](../tests); `setup/tests/regression` cubre las
utilidades y scripts de esta copia. El archivo `.patch` y las notas siguientes son
históricos, no instrucciones para parchear la versión actual.

Aplicado el 2026-09-21 sobre omp 18.2.7 + plugin `omp-claude-bridge` 0.8.1.

## Qué hay aquí

- `config.yml` — copia de `~/.omp/agent/config.yml` con el bloque `retry:` (fallbackChains, usageAwareFallback, etc.).
- `omp-claude-bridge-0.8.1-fallback-opus5-context.patch` — parche al plugin (`~/.omp/local/omp-claude-bridge/src/`):
  1. `rate-limit.ts` / `index.ts`: cuando el SDK de Claude Code emite `rate_limit_event` con `status: "rejected"`
     (o un `result` con `is_error`), el turno termina con error 429 `usage_limit_reached` + `retry-after-ms=`
     en vez de un `stop` silencioso. Así omp marca claude-bridge como agotado y salta a la cadena de fallback.
  2. `models.ts`: añade `claude-opus-5` (1M por defecto, variante `-200k`).
  3. `index.ts` (2026-09-21, pérdida silenciosa de contexto — upstream pi-claude-bridge #55/#62): cuando el
     historial de omp llega más corto que el cursor de la sesión de Claude Code (poda, deriva tras un steer diferido,
     compactación cuyo `needsRebuild` se perdió), el bridge hacía "Case 1 synthetic" = lanzar Claude Code **sin
     `--resume`** → el modelo solo veía el último mensaje ("¿adelante con qué?"). Ahora en el hilo principal
     reconstruye la sesión con el historial completo (`Case 4 drift`); el clean start queda solo para llamadas
     reentrantes (subagentes). Además los handlers de fin de query conservan `needsRebuild`/`forceRotate`.
     Síntoma en `~/.omp/logs`: `assistantUsageContextTokens` cae de ~290k a ~25k con `storedContextTokens` estable.
     Revisado con Fable 5.1 el 2026-09-22 y ajustado: las llamadas reentrantes (subagentes) nunca reconstruyen ni
     adoptan la sesión compartida (ni con `needsRebuild`, ni en el handler de fin, ni en `.catch`); las side-requests de
     0 mensajes previos preservan la sesión; un steer diferido perdido o fallido marca `needsRebuild`.
     Test: `tests/session-drift.test.ts` (7 casos, bun; requiere copia de `src` con stubs de `@oh-my-pi/*`, ver abajo).
  4. `index.ts` + `config.ts` (2026-09-22, calidad "Claude no sabe usar el árbol de tareas"): Claude Code **trunca a 2048
     caracteres** la descripción de cada tool MCP, y omp expone sus tools así (`todo` 3551, `task` 4666, `edit` 5235,
     `hub` 6972, `eval` 14904 chars): los ejemplos de uso nunca llegaban. Además el bridge solo reenviaba AGENTS.md y
     skills, **no el system prompt de omp** (30k chars: inventario de tools, workflow todo/task, delegación, edit).
     Ahora añade al prompt de Claude Code: (a) el system prompt de omp bajo "# Host harness instructions (Oh My Pi)",
     (b) "# Full tool reference" con las descripciones completas de las tools > 2048 chars, y (c) un aviso al inicio de
     esas descripciones. Desactivable con `provider.forwardHostPrompt: false` en `~/.omp/agent/claude-bridge.json`.
     Coste: ~21k tokens más de prefijo cacheado por sesión (36k vs 15k). Con `CLAUDE_BRIDGE_DEBUG=1` vuelca
     `~/.omp/agent/claude-bridge-tools.json` y `claude-bridge-sysprompt.txt`, y loguea `mcp tools (N, ! = > 2048)`.
  5. **Esfuerzo**: un rol `claude-bridge/<modelo>` sin sufijo con `defaultThinkingLevel: auto` llega al SDK como
     `effort=low` (medido). Poner siempre sufijo: `claude-bridge/claude-sonnet-5:high`. En CLI `--model x:high` no vale.

6. **Mensajes `developer`** (2026-09-22, commit `aab83a5` del fork, diseño revisado con gpt-6-astra): omp manda
   con rol `developer` los recordatorios de todo, reglas TTSR y avisos de parada. El bridge solo aceptaba `user`:
   un recordatorio final llegaba como `[continue]` (64 `empty_prompt` en `claude-bridge-diag.log` en un día), en
   steer se descartaba y en rebuild desaparecía. Ahora `convert.ts` convierte user/developer igual (developer
   envuelto en `<system-reminder>` "Message from the Oh My Pi harness…"), el prompt es todo lo pendiente tras el
   último assistant, el steer también lo entrega, la ruta de huérfanos no lo silencia, y el rebuild agrupa los
   user consecutivos y escribe los bloques completos (`importMessagesLossless`: el `importMessages` de
   cc-session-io tiraba texto e imágenes junto a tool_results). Test: `tests/developer-input.test.ts` (11 casos).
   Comprobar: `grep "prompt from" ~/.omp/agent/claude-bridge.log` y que no crezca `empty_prompt` en el diag.
   Revisión y cierre por gpt-6-astra (commit `f968a3e`): callbacks duplicados, huérfanos en ambos órdenes,
   `QueryContext.ownsSharedSession` (subagentes/side requests no tocan la sesión principal ni el prewarm),
   askClaude con `history` explícito, imágenes en tool_results, IDs saneados únicos. Tests:
   `developer-input.test.ts` + `developer-routing.test.ts` (SDK simulado); 74 pass. Verificado en real el
   22/09: recordatorio de todo → `prompt from 1 pending message(s): [4]developer`, `Case 3` resume.
   **0.9.2** (23/09, `32ae30f`): el guard de duplicados de 0.9.1 comparaba longitudes; tras una compactación a
   mitad de turno el contexto es más corto → se tomaba por duplicado → 3 "empty stop" y Claude Code colgado
   esperando la tool. Ahora duplicado = todos los ids de resultado ya entregados. Releases v0.9.1/v0.9.2 en el fork.
   **0.9.4** (`fb37014`): subagentes con historial reanudan una sesión efímera propia (antes arrancaban sin historial tras un recordatorio). **0.9.5** (`34d3d34`): los eventos de sesión de subagentes ya no borran la sesión principal (propiedad por `ctx.sessionManager`); recap/`/btw` (`:side:`) van a snapshot efímero. 94 tests. **0.9.6** (`6fdbd38`): compactación a mitad de turno retira la consulta viva y continúa en una nueva con el historial compactado (antes: bucle de compactaciones, el contexto de Claude no bajaba). Verificado en real con umbral 30k. 104 tests. Deja JSONL rotados en ~/.claude/projects (limpieza pendiente).

Backup previo de la config: `~/.omp/agent/config.yml.bak-20260921`.

## Cadenas (mismo nivel en el otro proveedor)

| Si falla | Salta a |
|---|---|
| claude-bridge/claude-sonnet-5 | openai-codex/gpt-6-sol |
| claude-bridge/claude-fable-5-1m | openai-codex/gpt-6-astra |
| claude-bridge/claude-opus-5-5, claude-opus-5 | openai-codex/gpt-6-sol |
| claude-bridge/claude-haiku-4-5 | openai-codex/gpt-6-luna |
| claude-bridge/* | openai-codex/gpt-6-sol |
| openai-codex/gpt-6-luna, gpt-5.6-luna | claude-bridge/claude-haiku-4-5 |
| openai-codex/gpt-5.6-terra, gpt-5.5 | claude-bridge/claude-sonnet-5 |
| openai-codex/gpt-6-sol, gpt-5.6-sol | claude-bridge/claude-opus-5-5 |
| openai-codex/gpt-6-astra | claude-bridge/claude-fable-5-1m |
| openai-codex/* | claude-bridge/claude-sonnet-5 |

Entradas sin sufijo heredan el esfuerzo del turno fallido (`xhigh` en Claude se recorta a `high`).
`fallbackRevertPolicy: cooldown-expiry` devuelve al modelo primario cuando vence la ventana de cuota.

## Instalación (desde 2026-09-22: repo propio, no directorio local)

El plugin ya no es un enlace a `~/.omp/local/omp-claude-bridge`: se instala desde el fork.

```bash
omp plugin install git:github.com/esp3tek/omp-claude-bridge
```

- Instala en `~/.omp/plugins/node_modules/omp-claude-bridge` (copia real, ya no symlink) y registra
  `0.9.0` en `omp-plugins.lock.json`. Las dependencias se izan a `~/.omp/plugins/node_modules`.
- **Actualizar**: `omp plugin install git:github.com/esp3tek/omp-claude-bridge --force` tras hacer
  push al fork. Un `omp plugin upgrade` genérico ya no puede pisarlo con el 0.8.1 de upstream,
  porque la fuente es el fork.
- `~/.omp/local/omp-claude-bridge` sigue siendo el **clon de trabajo** (remotos `origin` = DevVig,
  `fork` = esp3tek). Ahí se desarrolla y se prueba; lo que omp carga es lo instalado.
- Ciclo: editar en el clon → `bun test tests/*.test.ts` → commit y push a `fork main` →
  reinstalar con `--force` → reiniciar las sesiones de omp.

Este README y el parche `.patch` quedan como histórico de cómo se llegó hasta aquí; la fuente de
verdad es el repo.

## Pruebas locales

Requiere Node 24, Bun y el clon de desarrollo con sus dependencias instaladas:

```bash
node tests/run-unit.mjs
```

Ejecuta las regresiones de esta carpeta y las pruebas vigentes del plugin en
`~/.omp/local/omp-claude-bridge`, incluidos sus fixtures. Para otro clon:
`node tests/run-unit.mjs <ruta>`. No consume cuota. Las copias históricas de tests
en esta carpeta no se ejecutan directamente; véase [tests/README.md](tests/README.md).

La copia de `config.yml` está sincronizada con el modelo predeterminado activo:
`claude-bridge/claude-opus-5-5-1m:high` (2026-09-25).

`bun roles-report.ts --days N` filtra el consumo por fecha de cada evento, conserva
los cambios previos de rol y fallback, y omite eventos sin fecha válida cuando se
solicita un periodo. Sin `--days` incluye todo el historial.

Con `CLAUDE_BRIDGE_DEBUG=1` (puesto con `setx` el 2026-09-21), el log `~/.omp/agent/claude-bridge.log` debe mostrar
`Case 4 drift` en vez de `Case 1 synthetic` cuando omp acorte el historial; y nunca `resume=none` con `msgs>1` en el hilo principal.

## Depuración (activa de forma permanente)

`CLAUDE_BRIDGE_DEBUG=1` está puesto a nivel de usuario (`setx`); solo lo ven las terminales abiertas después. Con él el bridge escribe:

| Fichero | Qué hay |
|---|---|
| `~/.omp/agent/claude-bridge.log` | cada decisión del bridge: `fresh query` (modelo, effort, reasoning, resume, sysPrompt, settings), `syncResult`/`Case N`, tool results y handlers MCP, steer, prewarm, usage por turno (`cachePct`), cuota (`usage: 5h=…`), tamaños de descripciones de tools, rate limits, errores con stack |
| `~/.omp/agent/cc-cli-logs/<fecha>-<provider|prewarm|compact-summary>-N.log` | el debug interno de Claude Code de esa query: plugins/hooks cargados, peticiones API, `cc_version`, MCP |
| `~/.omp/agent/claude-bridge-diag.log` | volcados JSON de fallos de verificación de sesión |
| `~/.omp/agent/claude-bridge-tools.json`, `claude-bridge-sysprompt.txt` | las tools y el system prompt de omp tal como los recibió el bridge en la última query |
| `~/.omp/logs/omp.<fecha>.<pid>.log` | log de omp (ya a nivel debug): `Auto-compaction threshold decision` (`assistantUsageContextTokens` vs `storedContextTokens`), `Usage fetch`, `agent_end` |

Retención automática (2026-09-22): al arrancar, borra `cc-cli-logs` de más de 7 días (`CLAUDE_BRIDGE_DEBUG_KEEP_DAYS`) y rota `claude-bridge.log`/`-diag.log` a `.1` al pasar de 20 MB (`CLAUDE_BRIDGE_DEBUG_MAX_MB`). Coste: ~10-40 KB por query, sin impacto en latencia.

Búsquedas útiles:
```bash
L=~/.omp/agent/claude-bridge.log
grep -n "Case |syncResult" $L | tail          # cómo se resolvió la sesión en cada turno
grep -n "resume=none" $L | grep -v "msgs=1"     # turno sin historial en el hilo principal = bug
grep -n "prewarm|steer|skipping tool_use" $L
grep -n "usage: in=" $L | tail                  # cachePct bajo = prefijo frío
grep -n "WARNING|BUG|error" $L | tail
```

## Comprobar

```bash
omp models | grep opus-5                 # debe listar claude-opus-5 y claude-opus-5-200k
omp config get retry.fallbackChains      # JSON con las cadenas
omp usage                                # cuota Codex (claude-bridge no reporta cuota a omp)
grep -h "Fallback chain" ~/.omp/logs/omp.$(date +%F).*.log   # sin avisos con el bridge cargado
```

Depurar el bridge: `CLAUDE_BRIDGE_DEBUG=1 omp …` escribe en `~/.omp/agent/claude-bridge.log`.
