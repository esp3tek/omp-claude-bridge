# Tests

## Unit (`bun`, no network, no quota)

```bash
node tests/setup-stubs.mjs   # inert stubs for the host packages omp provides at runtime
bun test tests/*.test.ts
```

| File | Covers |
| ---- | ------ |
| `session-drift.test.ts` | `syncSharedSession` with explicit history: shortened main contexts rebuild; reentrant history gets a private session; zero-prior side requests preserve the shared session |
| `thinking.test.ts` | Historical thinking replay and unique, stable tool IDs after sanitization |
| `pack.test.ts` | Condensing omp's real tool descriptions (`fixtures-omp-tools.json`) under Claude Code's 2048-character limit while keeping `<critical>` and the examples |
| `prompt-stream.test.ts` | The stdin generator: acks resolve on delivery, and abandoning the consumer settles every queued push instead of leaving it pending |
| `usage.test.ts` | Quota from SDK rate-limit events: `unifiedWindows` fractions, the documented percentage fallback, stale windows, values on an unknown scale |
| `claude-models.test.ts` | Collapsing Claude Code's picker entries into base model ids and 1M capability |
| `developer-input.test.ts` | Developer markers, multiple pending inputs, interleaved results, lossless images and rebuilt tool pairing |
| `developer-routing.test.ts` | Real provider routing with simulated SDK `query`/`startup`: developer input during MCP execution, write-ack ordering, duplicate callbacks, orphans, aborts, prewarm reuse and AskClaude history; child-history replay and parent isolation; private-file cleanup on completion without init, iterator/startup errors and aborts |

The routing fixture runs the production provider and MCP routing closures, not helper-only
approximations. It replaces SDK transport and the host event sink, so it exercises no live
Claude Code process. Session files and diagnostics stay in temporary directories inside
the repository, removed after each test file.

## Integration (`node`, drives omp over its RPC protocol — spends quota)

Each script starts `omp --mode rpc` in `%TEMP%\bridge-smoke`, which must exist and hold the
`high.yml` / `med.yml` fixtures the prompts read. Pass a model as the first argument
(default `claude-bridge/claude-haiku-4-5`).

| Script | Asserts |
| ------ | ------- |
| `steer-test.mjs` | A steer sent while a tool runs reaches Claude Code in the same turn |
| `abort-test.mjs` | Abort mid-tool, then a fresh prompt: no hang, history intact |
| `compact-test.mjs` | `/compact` completes and the turn after it still has the context |
| `subagent-test.mjs` | Parallel subagents, then a normal turn: the provider survives their teardown |
| `prewarm-test.mjs` | Time to first token across three turns (pre-warm on vs off) |
| `switch-test.mjs` | claude-bridge → Codex → claude-bridge without losing history |
| `models-rpc.mjs` | Which claude-bridge models a live session offers |

`CLAUDE_BRIDGE_DEBUG=1` is set for the child, so `~/.omp/agent/claude-bridge.log` carries the
session-sync decisions each run made.
