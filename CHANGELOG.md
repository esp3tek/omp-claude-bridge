# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-09-22

First release of the `esp3tek` fork, on top of `DevVig/omp-claude-bridge` 0.8.1.
Verified against omp 18.2.8 and Claude Code 2.1.278 on Windows.

### Fixed
- **Silent conversation-history loss.** A main-thread context shorter than the session
  cursor took a clean-start path, running Claude Code with no `--resume` and therefore no
  history: the model answered the last message with nothing behind it. It now rebuilds the
  session instead. Reentrant (subagent) calls never rebuild or adopt the shared session, and
  a query completing while a compaction sets `needsRebuild` no longer drops that flag.
  (Same class as upstream pi-claude-bridge #55 / #62, reached by a different route.)
- **The provider disappeared after a parallel `task`.** The host drops every runtime provider
  registered by an extension source when one of that source's instances is torn down, so a
  finished subagent took `claude-bridge` out of the shared registry and the parent's next turn
  failed with "No API key for provider: claude-bridge". Registration is now idempotent and
  re-runs on `session_start` and `session_shutdown`, always installing the owning instance's
  `streamSimple`. (Upstream #91.)
- **Compaction is no longer taken over.** The takeover ran inside an extension handler the host
  aborts at 30 seconds; a real context does not summarize in that time, and a discarded takeover
  left the session uncompacted. The bridge now declines and omp asks for the summary through the
  normal provider path, which has no deadline. `provider.compactTakeover: true` restores it.
- **A model discovery failure no longer empties the provider.** The host treats the dynamic model
  list as authoritative, so a throw or an empty result left `claude-bridge` with no models at all.
- Tool calls naming a tool the bridge does not serve are no longer forwarded to omp, which used
  to execute them for real while Claude Code rejected and retried them under a fresh id.

### Added
- **omp's system prompt and full tool descriptions reach the model.** Claude Code truncates MCP
  tool descriptions at 2048 characters; omp's `edit`, `task`, `todo`, `hub` and `eval` were
  arriving cut off. Long descriptions are condensed to fit (summary, `<critical>`, `<instruction>`,
  as many `<example>` blocks as fit) and the full text goes to the system prompt alongside omp's
  own prompt. `provider.systemPrompt: "host"` runs on omp's prompt alone, without Claude Code's
  preset. `provider.forwardHostPrompt: false` opts out.
- **Mid-turn steering** (ported from pi-claude-bridge 0.7.0): the prompt is a parked stdin
  generator, so a steer typed while a tool runs reaches Claude Code in the same turn. The
  deferred-replay loop is gone.
- **omp's JSON schemas are served verbatim** (ported, upstream #44): the Zod round trip flattened
  nested objects and dropped `anyOf`/`const`, hiding the shape of `todo.list[]`, `task.tasks[]` and
  the `edit` ops. Results pair by Claude Code's `tool_use` id instead of call order.
- **Pre-warm**: the next Claude Code process is spawned and resumed between turns
  (`provider.prewarm`, measured ~1.5 s less per message). Discarded on rebuild, abort, error,
  compaction, tree navigation and after 10 minutes.
- **Subscription quota reaches omp** through a `usage` resolver that reads Claude Code's OAuth
  token, so `omp usage`, the status bar and `retry.usageAwareFallback` see the 5h / 7d windows.
- **The model list comes from Claude Code's own picker** (`supportedModels()`), cached by omp; the
  static list is the fallback. Adds Claude Fable 5.1 and Opus 5.
- **`provider.replayThinking`** (default `"last"`): historical `thinking` blocks are no longer
  replayed into rebuilt sessions, which shrinks them considerably.
- **`provider.pathToClaudeCodeExecutable`** is now the documented way to run a newer Claude Code
  than the one the SDK bundles — required for Fable 5.1, which needs 2.1.251+.
- Isolation from `~/.claude` when forwarding omp's prompt (`settingSources: ["project"]`), so the
  user's plugins, hooks and skills stop loading on every turn.
- Debug artifacts are pruned automatically (`CLAUDE_BRIDGE_DEBUG_KEEP_DAYS`,
  `CLAUDE_BRIDGE_DEBUG_MAX_MB`) so debug logging can stay on permanently.
- Safeguard refusals are named, with what actually fixes them, instead of being retried blindly.

### Notes
- Compaction with omp's `snapcompact` method injects an archive whose preamble describes
  reconstructing a verbatim transcript including the assistant's reasoning. Opus 5 refuses the
  turn over it (`apiRefusalCategory: reasoning_extraction`) regardless of what the archive
  actually contains. Drop `snapcompact` from `compaction.methodOrder`; clear already-archived
  frames with `/shake images`.

## [0.8.1] - 2026-07-07

### Fixed
- Spurious "Claude rate limit warning" toasts at trivial utilization. The Claude
  Agent SDK emits `allowed_warning` rate-limit events even at ~1% of the
  `seven_day` (weekly) limit; these are now surfaced only at ≥80% utilization.
  Hard-limit (`rejected`) notifications and the debug log are unchanged.

## [0.8.0] - 2026-07-07

### Added
- On-demand context-window variants in the `/model` picker: each model is now
  registered once per window it supports (1M and/or 200K) as a distinct,
  clearly-labeled entry (e.g. `Opus 4.8 (1M)` and `Opus 4.8 (200K)`). Switching
  a model's context window is a picker selection instead of a config edit plus
  reload.
- Suffixed model ids (`<model>-1m` / `<model>-200k`) that force a specific
  window regardless of the global default — usable from `modelRoles` and
  AskClaude short names. The unsuffixed id remains the config default, so
  existing `config.yml` roles keep working.

### Changed
- `provider.contextWindow` now sets the **default** window (which window the
  unsuffixed model id maps to) instead of hiding models that don't match it.
  Both windows stay pickable wherever a runtime exists.
- Each variant reports its true `contextWindow`, keeping the status bar and
  auto-compaction accurate for the selected window.

## [0.7.0] - 2026-07-06

First public release of the Oh My Pi port.

### Added
- `provider.contextWindow` setting with three modes:
  - `"auto"` (default) — per-model context policy based on measured SDK behavior.
  - `"1m"` — force the 1M context window; only 1M-capable models are registered.
  - `"200k"` — force the 200K context window; only 200K-capable models are registered.
- Models without a runtime for the selected forced window are hidden from the
  model picker instead of being misreported.
- `thinkingLevelMap` fallback so Sonnet 5 / Sonnet 4.6 expose `xhigh` (mapped to `max`).

### Changed
- Ported from Pi (`@earendil-works/*`) to Oh My Pi (`@oh-my-pi/*`): extension
  manifest (`omp.extensions`), provider registration, message conversion, and
  config directory resolution (`~/.omp/agent/claude-bridge.json`).
- Corrected the `claude-fable-5` context policy: the bare `claude-fable-5`
  runtime serves 200K (verified), while `claude-fable-5[1m]` serves 1M. In
  `"auto"` mode Fable 5 now registers at 200K.

### Credits
- Original `pi-claude-bridge` by [Eli Dickinson](https://github.com/elidickinson).
- Oh My Pi port and context-window controls by [Jonathan Borgwing](https://github.com/DevVig).
