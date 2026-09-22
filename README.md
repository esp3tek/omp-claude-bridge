<div align="center">

<img src="assets/banner.svg" alt="omp-claude-bridge — Run Claude Code natively inside Oh My Pi" width="100%" />

<h1>omp-claude-bridge</h1>

<p><strong>Run Claude Code as a first-class model provider inside <a href="https://omp.sh">Oh My Pi</a> — with an AskClaude delegation tool and switchable 1M / 200K context windows.</strong></p>

<p>
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
<img alt="Oh My Pi extension" src="https://img.shields.io/badge/Oh%20My%20Pi-extension-6E56CF">
<img alt="Claude Agent SDK" src="https://img.shields.io/badge/Claude%20Code-Agent%20SDK-D97757">
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
<a href="https://github.com/esp3tek/omp-claude-bridge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/esp3tek/omp-claude-bridge/actions/workflows/ci.yml/badge.svg"></a>
<img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

</div>

---

`omp-claude-bridge` lets you drive **Claude Code** — Opus, Sonnet, Haiku, and Fable — from inside Oh My Pi, with every tool call flowing through OMP's native TUI. It also exposes an **AskClaude** tool so any other provider can delegate a task or a second opinion to Claude Code, and it gives you **direct control over the context window** each model requests.

Authentication and billing run through Claude Code and your Anthropic subscription via the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) — this extension never stores credentials.

<div align="center">
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</div>

## About this fork

This is a fork of [DevVig/omp-claude-bridge](https://github.com/DevVig/omp-claude-bridge) 0.8.1,
itself a port of [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge).
Upstream's omp port has not been updated since July 2026, so the fixes below live here.

**Ported from `pi-claude-bridge` 0.7.0/0.8.0** (they exist upstream for Pi, not in the 0.8.1 omp port):

- Mid-turn steering: the prompt is a parked stdin generator, so a steer typed while a tool runs
  reaches Claude Code in the same turn instead of being replayed afterwards. Replaces the
  deferred-replay loop, which was the root of upstream issue #55.
- omp's JSON schemas are served to Claude Code verbatim instead of going through Zod, which
  flattened nested objects and dropped `anyOf`/`const` (upstream #44). Tool results are paired by
  Claude Code's own `tool_use` id rather than call order.
- A `tool_use` naming a tool we do not serve (the model reaching for a native `bash`/`Edit`) is no
  longer forwarded to omp, which used to execute it for real while Claude Code rejected it.
- An exhausted subscription surfaces as a 429 so omp walks its fallback chain (upstream #58).
- The provider is re-registered when a subagent's teardown removes it (upstream #91).

**New here:**

- **omp's own system prompt and tool descriptions reach the model.** Claude Code truncates every
  MCP tool description at 2048 characters, so omp's `edit`, `task`, `todo`, `hub` and `eval`
  descriptions arrived cut off, examples first to go. Long descriptions are now condensed to fit
  and their full text goes into the system prompt, together with omp's own prompt (tool inventory,
  todo/task workflow, delegation rules). `provider.systemPrompt: "host"` drops Claude Code's
  preset entirely and runs on omp's prompt alone.
- **The child is isolated from `~/.claude`** (`settingSources: ["project"]`): the user's plugins,
  hooks and skills no longer load on every turn.
- **Context is never silently lost.** A main-thread context shorter than the session cursor now
  rebuilds the Claude Code session instead of starting clean, which used to run a turn with no
  history at all (upstream #55/#62 reached by a different route). Reentrant calls never rebuild
  or adopt the shared session.
- **Compaction is left to omp.** Taking it over runs inside an extension handler the host aborts
  at 30 seconds — not enough for a real context, and a discarded takeover left the session
  uncompacted. Declining hands the summary to omp's normal provider path, which has no deadline.
  Still available with `provider.compactTakeover: true`.
- **The next Claude Code process is pre-warmed** between turns (measured: ~1.5 s less per message).
- **Claude subscription quota reaches omp** (the status bar, `retry.usageAwareFallback`), built from
  the rate-limit events the SDK reports during a turn — no credential is read (see below).
- **The model list comes from Claude Code's picker** (`supportedModels()`), so a model the installed
  binary and plan actually serve shows up without a code change; the static list is the fallback.
  Adds Claude Fable 5.1 and Opus 5.
- **Historical `thinking` blocks are not replayed** by default (`provider.replayThinking`), which
  shrinks rebuilt sessions considerably.

**Known interaction with Opus 5:** after omp compacts with `snapcompact`, the archive it injects
carries a preamble describing how to reconstruct a verbatim transcript including the assistant's
reasoning. Opus 5's classifier reads that as duplicating model outputs and refuses the turn
(`apiRefusalCategory: reasoning_extraction`). It is not about the archive's contents — the one we
traced held no reasoning at all. Remove `snapcompact` from `compaction.methodOrder`, and clear
frames already archived with `/shake images`.

## How it reaches Claude, and why that matters

Anthropic lets you use a Claude subscription from the Agent SDK, which runs Claude Code itself.
It does not let you take the OAuth credential Claude Code holds and drive the API with it from
somewhere else. This extension exists to stay on the right side of that line, so the line is
drawn in the code rather than in a promise:

- **Every request to Anthropic is made by Claude Code**, spawned through the official
  [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript).
  Authentication, billing and quota are Claude Code's, exactly as if you had typed into it.
- **The extension does not read, store or inspect a credential of its own.** It never opens
  `.credentials.json`, sets no `Authorization` header, and makes no network request outside the
  SDK — there is no `fetch` anywhere in `src/`. Quota reporting is built from the
  `rate_limit_event` messages the SDK already delivers during a turn (see `src/usage.ts`).
  The one caveat worth stating plainly: the Claude Code subprocess **inherits this process's
  environment**, so if you have `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` set, Claude Code
  receives them like any other child process would — the bridge neither reads their values nor
  adds them, but it does not strip them either, and it warns when they are present.
- **It warns instead of going along with a redirect.** `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` in your environment are inherited by the child
  and change where its requests go or what pays for them; the bridge says so once per session
  rather than letting subscription traffic quietly leave Anthropic.

**Scope.** This is meant for running Claude Code yourself, with your own subscription, from your
own machine. Anthropic's SDK documentation separately restricts *offering* claude.ai
authentication or subscription limits as part of a product to other people without prior
approval; nothing here is built for that, and putting it behind a service for others would be a
different question that this README does not answer for you.

What it does do is shape the session Claude Code works from: it writes omp's conversation into a
Claude Code session file under `~/.claude/projects/<project>/<uuid>.jsonl` and resumes it, serves
omp's tools over an in-process MCP server, and forwards omp's system prompt and your
`AGENTS.md` / `CLAUDE.md`. All of that is what the SDK is for.

One consequence of staying inside the SDK: a quota window is unknown until a turn has reported
it, so a session shows no Claude quota until its first turn finishes, and `omp usage` run as a
standalone command — a fresh process that never takes a turn — shows none at all.

### Debug logging

`CLAUDE_BRIDGE_DEBUG=1` is verbose on purpose, and worth understanding before leaving it on:
`~/.omp/agent/claude-bridge.log` records the first 60 characters of each prompt, truncated tool
results, and Claude Code's stderr; `cc-cli-logs/` holds Claude Code's own debug stream per query;
`claude-bridge-sysprompt.txt` and `claude-bridge-tools.json` hold omp's full system prompt and
tool descriptions as captured on the last turn. **None of it is redacted.** A secret that appears
in a prompt, a file you read, or a tool's output can therefore end up in those files. They stay on
your machine and are pruned at startup (`CLAUDE_BRIDGE_DEBUG_KEEP_DAYS`, default 7;
`CLAUDE_BRIDGE_DEBUG_MAX_MB`, default 20 — a size cap applied at startup, not continuously), but
if you work with secrets in context, leave debug off or delete the directory afterwards.
## Table of contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Context window controls](#context-window-controls)
- [Models](#models)
- [AskClaude tool](#askclaude-tool)
- [Configuration reference](#configuration-reference)
- [How it works](#how-it-works)
- [Debugging](#debugging)
- [Development](#development)
- [Credits](#credits)
- [License](#license)

## Features

- **Claude Code as a provider** — pick Opus / Sonnet / Haiku / Fable from `/model`; tool calls render in OMP's TUI like any native provider.
- **AskClaude delegation tool** — from any other provider, hand a task or question to Claude Code (read-only, no-tools, or full read/write/bash), optionally in an isolated session.
- **Switchable context window** — force **1M** or **200K** globally, or leave it on measured per-model defaults. This is the headline addition in this fork.
- **Session resume & persistence** — conversations survive across turns and reconnects.
- **Skills + AGENTS.md forwarding** — your OMP skills and context files are passed into Claude Code's system prompt.
- **Thinking support** — effort levels map through to Claude Code, including `xhigh` on Sonnet models.
- **MCP tool bridging** with strict-config isolation by default.

## Install

```bash
omp plugin install git:github.com/esp3tek/omp-claude-bridge
```

<details>
<summary>Other install methods</summary>

```bash
# From the full HTTPS URL
omp plugin install https://github.com/esp3tek/omp-claude-bridge

# From a local checkout (great for hacking on it)
git clone https://github.com/esp3tek/omp-claude-bridge.git
omp plugin install ./omp-claude-bridge
```

</details>

Requires Oh My Pi (`omp`) and a working Claude Code login.

## Quickstart

1. Install the plugin (above).
2. In OMP, run `/model` and choose a `claude-bridge/*` model — for example `claude-bridge/claude-sonnet-5`.
3. Work as usual. Tool calls run through OMP's TUI; Claude Code handles the model turn.

To delegate from another provider instead, just ask: *"Ask Claude to review this plan and poke holes in it."*

## Context window controls

Claude Code serves different context windows depending on the exact model id it receives (e.g. bare `claude-fable-5` serves 200K, while `claude-fable-5[1m]` serves 1M). `omp-claude-bridge` exposes both as **separate entries in the `/model` picker**, so you choose the window on demand:

- `claude-bridge/claude-opus-4-8` → **Opus 4.8 (1M)**
- `claude-bridge/claude-opus-4-8-200k` → **Opus 4.8 (200K)**

Switching window is just picking the other entry — no config edit, no reload. Every model appears once per window it supports, the `(1M)` / `(200K)` label is always shown, and each entry reports its true window so OMP's status bar and auto-compaction threshold stay accurate.

### Default window

The **unsuffixed** id (e.g. `claude-opus-4-8`) maps to a default window; the other window gets a `-1m` / `-200k` suffixed id. `provider.contextWindow` in `~/.omp/agent/claude-bridge.json` picks that default — it no longer hides models, it only decides which window is unsuffixed:

```json
{
  "provider": {
    "contextWindow": "auto"
  }
}
```

| Mode | Default (unsuffixed) window |
| ---- | -------- |
| `"auto"` *(default)* | Per-model measured default. Respects `plan` and `longContextExtraUsage`. |
| `"1m"` | 1M where the model has a 1M runtime, else its only window. |
| `"200k"` | 200K where the model has a 200K runtime, else its only window. |

Both windows stay in the picker regardless of this setting (wherever a runtime exists); it only changes which one is the plain, unsuffixed id. So `modelRoles` / `enabledModels` that reference `claude-bridge/claude-opus-4-8` keep working and follow the default.

### Windows offered per model

| Model | 200K entry | 1M entry | `auto` default |
| ----- | :--------: | :------: | :------------: |
| `claude-opus-4-8` | ✓ | ✓ | 1M |
| `claude-opus-4-7` | — | ✓ | 1M |
| `claude-opus-4-6` | ✓ | ✓ | 200K¹ |
| `claude-fable-5` | ✓ | ✓ | 200K |
| `claude-sonnet-5` | ✓ | ✓ | 1M |
| `claude-sonnet-4-6` | ✓ | ✓ | 200K² |
| `claude-haiku-4-5` | ✓ | — | 200K |

¹ Opus 4.6's `auto` default is 1M when `plan: "max"` or `longContextExtraUsage: true`.
² Sonnet 4.6's `auto` default is 1M when `longContextExtraUsage: true`.

The suffixed alternate exists only for the window that isn't the default — e.g. under `auto` you get `claude-opus-4-8` (1M) + `claude-opus-4-8-200k`, and under `"200k"` you get `claude-opus-4-8` (200K) + `claude-opus-4-8-1m`.

> Forcing 1M is a *request*: some models may still be **served** 200K by your subscription entitlement. Set `CLAUDE_BRIDGE_DEBUG=1` to log the served window (see [Debugging](#debugging)).

> An invalid `contextWindow` value logs a warning and falls back to `"auto"`, so a typo never breaks startup.

## Models

Pick any of these from `/model` — each entry shows a `(1M)` or `(200K)` label. The exact ids below assume the default `contextWindow: "auto"`; which id is unsuffixed vs `-1m` / `-200k` follows your configured [default window](#default-window).

| Picker id (auto) | Window |
| --------- | ------ |
| `claude-bridge/claude-fable-5` | 200K |
| `claude-bridge/claude-fable-5-1m` | 1M |
| `claude-bridge/claude-opus-4-8` | 1M |
| `claude-bridge/claude-opus-4-8-200k` | 200K |
| `claude-bridge/claude-opus-4-7` | 1M |
| `claude-bridge/claude-opus-4-6` | 200K (1M on Max / Extra Usage) |
| `claude-bridge/claude-opus-4-6-1m` | 1M |
| `claude-bridge/claude-sonnet-5` | 1M (supports `xhigh`) |
| `claude-bridge/claude-sonnet-5-200k` | 200K |
| `claude-bridge/claude-sonnet-4-6` | 200K (supports `xhigh`) |
| `claude-bridge/claude-sonnet-4-6-1m` | 1M |
| `claude-bridge/claude-haiku-4-5` | 200K (cheapest) |

Bash commands issued by Claude Code get a 120-second default timeout (matching Claude Code's default), since OMP's bash has no timeout by default.

## AskClaude tool

Available whenever the active provider is **not** claude-bridge. Your current model can hand work to Claude Code and wait for the result:

- "Ask Claude to plan a fix."
- "If you get stuck, ask Claude for help."
- "Ask Claude to review the plan in @foo.md, implement it, then ask an `isolated=true` Claude to review the implementation."
- "Ask Claude to poke holes in this theory."
- "Find all the places in the codebase that handle auth."

You can also bake it into a skill or AGENTS.md, e.g. *"Always call AskClaude to review complicated feature implementations before considering the task complete."*

### Parameters

| Parameter | Values | Description |
| --------- | ------ | ----------- |
| `prompt` | string | The question or task for Claude Code. |
| `mode` | `read` (default), `none`, `full` | `read` = read files + web; `full` = read/write/bash. Lock `full` out with `allowFullMode: false`. |
| `model` | `opus` (default), `sonnet`, `haiku`, or a full id | Which Claude model handles the delegation. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Effort level. |
| `isolated` | boolean (default `false`) | When `true`, Claude gets a clean session with no conversation history. |

## Configuration reference

Config is read from `~/.omp/agent/claude-bridge.json` (global) and the project OMP config directory `.omp/claude-bridge.json` (project; merged over global). A starter file lives at [`claude-bridge.example.json`](claude-bridge.example.json).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false
  },
  "provider": {
    "contextWindow": "auto",
    "plan": "pro",
    "longContextExtraUsage": false,
    "strictMcpConfig": true
  }
}
```

**`askClaude`**

| Key | Default | Description |
| --- | ------- | ----------- |
| `enabled` | `true` | Register the AskClaude tool. |
| `name` | `"AskClaude"` | Override the tool's OMP-side name. |
| `label` | `"Ask Claude Code"` | Override the TUI label. |
| `description` | — | Override the tool description shown to the model. |
| `defaultMode` | `"read"` | `"read"`, `"none"`, or `"full"`. |
| `defaultIsolated` | `false` | Start each call in a fresh session. |
| `allowFullMode` | `true` | Allow `mode: "full"`; set `false` to lock it out. |
| `appendSkills` | `true` | Forward OMP's skills block into the system prompt. |

**`provider`**

| Key | Default | Description |
| --- | ------- | ----------- |
| `contextWindow` | `"auto"` | `"auto"`, `"1m"`, or `"200k"`. See [Context window controls](#context-window-controls). |
| `plan` | `"pro"` | Set to `"max"` to enable Opus 4.6 at 1M in `auto`. |
| `longContextExtraUsage` | `false` | Opt into metered 1M usage (enables Sonnet 4.6 1M everywhere, Opus 4.6 1M on Pro). |
| `appendSystemPrompt` | `true` | Append OMP's AGENTS.md and skills. |
| `settingSources` | — | Claude Code filesystem settings to load; only applied when `appendSystemPrompt: false`. |
| `strictMcpConfig` | `true` | Block MCP servers from `~/.claude.json` / `.mcp.json`. Cloud MCP is always blocked. |
| `pathToClaudeCodeExecutable` | — | Path to the `claude` binary, if the bundled one can't run on your OS/filesystem. |

## How it works

OMP's built-in tools are bridged to Claude Code and back, so from your side it behaves like any other OMP provider. Model routing lives in [`src/models.ts`](src/models.ts), which is deliberately free of runtime imports so the context-window policy stays unit-testable in isolation. On registration, the extension projects the pi-ai model list, applies the selected context-window policy, and registers the resulting models with OMP.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` for detailed logs:

- **Bridge log** — `~/.omp/agent/claude-bridge.log`: every provider call, session-sync decision, tool-result delivery, and Claude Code stderr. Override the path with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CLI logs** — `~/.omp/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log`: the Claude Code subprocess's own debug stream, one file per query. Tags are `provider`, `continuation`, or `askclaude`.

When filing a session-resume bug (e.g. "No conversation found"), the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file are the most useful attachments.

## Development

```bash
git clone https://github.com/esp3tek/omp-claude-bridge.git
cd omp-claude-bridge
bun install

bun run typecheck   # tsc --noEmit
bun run test        # node --test unit suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. CI runs typecheck and tests on every push and PR.

## Credits

- Original **[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)** by **[Eli Dickinson](https://github.com/elidickinson)** — the streaming provider, MCP/tool bridging, session resume, and AskClaude tool this project builds on.
- Initial inspiration from [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.
- **Oh My Pi port and context-window controls** by **[Jonathan Borgwing](https://github.com/DevVig)**.

See [NOTICE](NOTICE) for full attribution.

> Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how Agent-SDK tool usage is billed. As of June 15, 2026 it uses your subscription quota just like Claude Code direct.

## License

[MIT](LICENSE) © 2026 Eli Dickinson (original) and Jonathan Borgwing (Oh My Pi port and context-window controls).
