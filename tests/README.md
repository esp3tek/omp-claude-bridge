# Tests

## Unit (`bun`, no network, no quota)

```bash
node tests/setup-stubs.mjs   # inert stubs for the host packages omp provides at runtime
bun test tests/*.test.ts
```

| File | Covers |
| ---- | ------ |
| `session-drift.test.ts` | `syncSharedSession`: a shorter main-thread context rebuilds instead of starting clean; reentrant calls never rebuild or adopt the shared session; zero-prior side requests preserve it |
| `thinking.test.ts` | `provider.replayThinking` — which historical `thinking` blocks reach a rebuilt session |
| `pack.test.ts` | Condensing omp's real tool descriptions (`fixtures-omp-tools.json`) under Claude Code's 2048-character limit while keeping `<critical>` and the examples |
| `claude-models.test.ts` | Collapsing Claude Code's picker entries into base model ids and 1M capability |

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
