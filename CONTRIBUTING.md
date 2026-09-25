# Contributing to omp-claude-bridge

Thanks for your interest in improving **omp-claude-bridge**. Contributions of all
sizes are welcome — bug reports, docs fixes, and features alike.

## Getting set up

```bash
git clone https://github.com/esp3tek/omp-claude-bridge.git
cd omp-claude-bridge
bun install        # or: npm install
```

Requirements:

- Node.js >= 20
- [Bun](https://bun.sh) to run the TypeScript provider tests
- Node.js 24 for the separate offline RPC smoke-script regressions
- An Oh My Pi install for end-to-end testing ([omp.sh](https://omp.sh))

## Developing against a live Oh My Pi

Point Oh My Pi at your working copy so changes load on the next run:

```bash
omp plugin install /absolute/path/to/omp-claude-bridge
```

Enable debug logging while iterating:

```bash
CLAUDE_BRIDGE_DEBUG=1 omp
# logs -> ~/.omp/agent/claude-bridge.log
```

## Checks before opening a PR

```bash
bun run typecheck   # tsc --noEmit
bun run test        # Bun provider tests + Node unit tests via tsx
node --test tests/regression/smoke-scripts.test.mjs  # Node 24, offline RPC checks
```

Run these checks before opening a PR. `bun install` must include the development
dependencies (`typescript` and `tsx`). CI currently runs typecheck and `bun run test`;
the separate offline RPC check is manual. See [tests/README.md](tests/README.md) for
coverage and the real integration scripts, which consume subscription quota.

## Coding guidelines

- TypeScript, ESM, tabs for indentation (match the surrounding files).
- Keep model routing changes in `src/models.ts`. It has **no runtime imports**,
  so it stays unit-testable in isolation — add a case to
  `tests/unit-context-window.mjs` when you touch context routing.
- Context-window behavior is derived from **measured** Claude Agent SDK output,
  not advertised metadata. If you change a model mapping, note how you verified
  the served window (the `result: served contextWindow=...` debug line).

## Reporting bugs

Open an issue using the bug template. A `~/.omp/agent/claude-bridge.log` excerpt
(run with `CLAUDE_BRIDGE_DEBUG=1`) makes bugs far easier to reproduce.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
