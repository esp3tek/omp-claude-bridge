# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.4] - 2026-09-23

### Fixed
- **Subagents lost their history after an unexpected-stop reminder.** A reentrant
  query with prior messages now imports its own history into a fresh, ephemeral
  Claude Code session and resumes it, rather than sending only the latest
  developer reminder. This also works before the main session exists, without
  changing the shared session, its cursor/rebuild flags, or its prewarmed process.
  Zero-history side requests still start clean.
- Ephemeral session snapshots and companion directories are cleaned up on success,
  abort, SDK errors, and synchronous query-start failures, even without an SDK init
  message. Isolated queries disable SDK persistence to prevent late abort writes
  from recreating deleted transcripts.
- Parallel tool-result delivery no longer reports `BUG: both maps non-empty` for
  unrelated tool IDs. The diagnostic checks for an unresolved result and handler
  with the same ID after the batch has been delivered.
- Session rebuild logs distinguish explicit `needsRebuild` (including compaction)
  and interleaved input from unannounced cursor drift.

## [0.9.3] - 2026-09-23

### Added
- `"debug": true` in `~/.omp/agent/claude-bridge.json` turns on the debug log like
  `CLAUDE_BRIDGE_DEBUG=1`, for omp sessions started from a terminal that predates the
  environment variable. `CLAUDE_BRIDGE_DEBUG=0` still forces it off.

## [0.9.2] - 2026-09-23

### Fixed
- **Mid-run compaction ended the turn with "Assistant returned empty stop after retry
  cap".** The duplicate tool-result guard added in 0.9.1 compared the context length with
  the last delivered length. omp compacts between provider calls, so the callback after a
  compaction carries a shorter context with new tool results; the bridge took it for a
  duplicate, answered an empty stop three times and left Claude Code waiting on its tool
  call. Duplicates are now detected by the result ids already handed to the query, and a
  shrunken context resets the input cursor so a reminder after the compaction is still
  steered in.

## [0.9.1] - 2026-09-23

Verified against omp 18.2.9 and Claude Code 2.1.278 on Windows.

### Fixed
- **Harness messages reached Claude as "[continue]".** omp sends todo reminders, TTSR
  rules and unexpected-stop nudges with role `developer`; the bridge only took a trailing
  `user` message as the prompt, so a reminder became the literal "[continue]" (Opus 5.5
  often answered with an empty stop), a reminder next to a tool result was never steered
  into the live query, and history rebuilds dropped developer messages. They now travel
  as user content wrapped in a `<system-reminder>` that marks them as harness input, on
  the fresh-query, steer and rebuild paths. The prompt is every user/developer message
  after the last assistant turn, not only the last one.
- **Lossy session rebuilds.** cc-session-io's `importMessages` kept only the
  `tool_result` blocks of a user message (dropping text and images next to them) and
  flattened the rest to text; rebuilds now write full content blocks. Consecutive user
  messages are merged, tool results first, before `repairToolPairing`, which otherwise
  replaced a real parallel result with a synthetic "[no tool result recorded]".
- Orphaned tool results now end quietly after abort, including when a developer reminder
  follows the result, without resetting an unrelated active query.
- Repeated tool-result callbacks cannot release MCP handlers before a pending developer
  write is acknowledged. Finalizing an earlier query no longer unregisters the next query.
- Subagents and zero-history side requests leave the main session's cursor, rebuild flags
  and prewarmed process untouched, including after aborts and failed side requests.
- Rebuilt tool results retain image blocks, and sanitized tool IDs remain unique even
  when an already-valid ID collides with an earlier sanitized ID.

### Changed
- Session synchronization takes explicit prior history. AskClaude passes its entire
  history separately from the delegation prompt, without appending a synthetic message.

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
- **Subscription quota reaches omp** through a `usage` resolver built from the `rate_limit_event`
  messages the SDK delivers during a turn, so the status bar and `retry.usageAwareFallback` see
  the 5h / 7d windows. No credential is read and no request is made outside the SDK: a window is
  simply unknown until a turn has reported it.
- **A warning when the environment would redirect the child.** `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are inherited by the Claude Code subprocess and
  change where its requests go or what pays for them; the bridge now says so once per session.
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

### Review follow-ups

Findings from an independent review of this release, fixed here:

- **A subagent could take over the main session.** `syncSharedSession` decided REUSE before it
  checked for a reentrant call, so a child whose history happened to line up with the parent's
  cursor was handed the parent's session id; a child rebuilding while no shared session existed
  published its own as the main one; and a child's tool results moved the shared cursor (40 to 3
  in the reproduction). Reentrancy is now decided first, and a reentrant call never reuses,
  rebuilds, publishes or advances the shared session.
- **A safeguard refusal is no longer retried on another model.** Re-sending a refused request
  until one model's safeguards accept it works around a protective measure rather than fixing the
  input; the refusal is now terminal, with a message saying what to change.
- **Rate-limit warnings showed the wrong reset time** (`resetsAt` is epoch seconds, handed to
  `Date` as milliseconds) and fired at 79.6% against an 80% threshold because the value was
  rounded before the comparison.
- Documentation corrected where it overstated the boundary: the Claude Code subprocess inherits
  this process's environment, debug logs are not redacted, and the scope is personal use with
  your own subscription.

### Review follow-ups, second pass

The remaining findings from the same review:

- **AskClaude answered without the recent history it promises.** In shared mode it resumed the
  existing session id outright, which is only current when the last turn went through this
  provider; after a turn on another provider, or a compaction, the session file was behind. It now
  runs the same sync the provider path runs, which reuses a current file and rebuilds a stale one.
- **AskClaude reported failures as empty successes.** A result carrying `is_error` (usage limit,
  auth, execution error) ended the loop normally and returned `{ responseText: "", stopReason:
  "stop" }`. The failure is now propagated.
- **AskClaude leaked a process when its signal arrived already aborted**: the throw happened
  before the `try`/`finally` that closes the query.
- **The pre-warm key could accept a differently-configured process.** It identified the system
  prompt by length plus its first 80 characters — shorter than the host-prompt header alone — and
  tools by name only, so an edited prompt or a changed tool schema still matched. It now digests
  the whole prompt, the tool definitions, the environment and the effective options.
- **A discarded pre-warm could come back.** A `startup()` still in flight when the process was
  discarded (shutdown, rebuild, replacement) published its handle on arrival. Each discard now
  bumps a generation, and a handle from a superseded one is closed instead of published.
- **The compaction takeover's deadline abandoned its work without stopping it.** `Promise.race`
  returned control to the host while the summary subprocess kept running, and spending, for a
  result nobody would read. The deadline now aborts it. (Only reachable with
  `provider.compactTakeover: true`.)
- **Sanitizing tool ids could merge two of them.** `call.a` and `call/a` both became `call_a`, so
  a rebuilt history could carry two `tool_use` blocks sharing an id. Substitution now keeps ids
  distinct.
- **Abandoning the prompt stream left queued pushes pending.** A consumer that stopped iterating
  settled only the in-flight message; the rest waited for an external `fail()`. The generator now
  rejects the whole queue itself, which is what the module's contract already claimed.

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
