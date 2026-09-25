# Tests

## Unit (Node 24 + Bun, no network, no quota)

```bash
node tests/run-unit.mjs
```

Runs the local regression tests, then the plugin's TypeScript and Node unit tests
from `~/.omp/local/omp-claude-bridge`. The clone must have its dependencies installed.
For another clone, use `node tests/run-unit.mjs <path>` or set `OMP_BRIDGE_SOURCE`.
The runner prints the path/version, propagates failures, and does not install or
modify the plugin. Node 24 runs the Node unit tests without `tsx`.

The `*.test.ts`, `unit-*.mjs` and `setup-stubs.mjs` copies are historical snapshots,
preserved in [`../archive/historical-tests.zip`](../archive/historical-tests.zip).
They are not a standalone plugin checkout: their `../src` and fixtures
belong to the development clone. Run the command above instead of `bun test tests/`.
The clone's current tests and fixtures are the source of truth.

From the plugin repository root, run `node setup/tests/run-unit.mjs .` to use that
checkout explicitly. The setup snapshot is kept in Git and is not part of the
plugin's runtime package.

`regression/` checks the report's date filter and drives all four corrected smoke
scripts with a simulated RPC process, including crashes, incomplete runs, rejected
commands and incorrect answers. These checks do not start omp or consume quota.

| File | Covers |
| ---- | ------ |
| `session-drift.test.ts` | `syncSharedSession`: a shorter main-thread context rebuilds instead of starting clean; reentrant calls never rebuild or adopt the shared session; zero-prior side requests preserve it |
| `thinking.test.ts` | `provider.replayThinking` — which historical `thinking` blocks reach a rebuilt session |
| `pack.test.ts` | Condensing omp's real tool descriptions (`fixtures-omp-tools.json`) under Claude Code's 2048-character limit while keeping `<critical>` and the examples |
| `prompt-stream.test.ts` | The stdin generator: acks resolve on delivery, and abandoning the consumer settles every queued push instead of leaving it pending |
| `usage.test.ts` | Quota from SDK rate-limit events: `unifiedWindows` fractions, the documented percentage fallback, stale windows, values on an unknown scale |
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

`compact`, `switch`, `prewarm` and `subagent` require a completed scenario and a clean
child exit. They reject RPC/assistant errors and check the final answer. `switch`
waits for each model-change acknowledgement before sending the next prompt;
`subagent` also requires an observed `task` invocation.
