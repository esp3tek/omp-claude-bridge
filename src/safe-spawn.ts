// Spawn the Claude Code child the way the SDK does, plus an 'error' listener on
// its stdin.
//
// The SDK's own spawnLocalProcess never listens for errors on the child's
// stdin. When the child dies while a write is in flight (an abort that lands
// right after spawn kills it with SIGTERM while the SDK is still pushing the
// initialize request or the first prompt), the pipe fails asynchronously with
// EPIPE. With no listener that 'error' event becomes an uncaught exception, and
// omp treats any uncaught exception as fatal: the whole session exits
// ("[Uncaught Exception] Error: EPIPE: broken pipe, write", seen 2026-10-05
// after aborting a subagent that was just starting).
//
// The write failure itself needs no handling: the SDK already learns about the
// dead child from its 'exit'/'error' events and its stdout closing, and ends
// the query. We only stop the stream error from escaping.

import { spawn } from "child_process";
import type { Options, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const EXPECTED_PIPE_ERRORS = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ECONNRESET"]);

export function spawnClaudeCodeSafely(
	options: SpawnOptions,
	stderr?: (data: string) => void,
	log?: (msg: string) => void,
): SpawnedProcess {
	const { command, args, cwd, env, signal } = options;
	const child = spawn(command, args, {
		cwd,
		env,
		signal,
		stdio: ["pipe", "pipe", stderr ? "pipe" : "ignore"],
		windowsHide: true,
	});
	child.stdin.on("error", (err: NodeJS.ErrnoException) => {
		const code = err.code ?? "";
		log?.(`safe-spawn: ${EXPECTED_PIPE_ERRORS.has(code) ? "ignored" : "swallowed unexpected"} stdin error from Claude Code pid=${child.pid ?? "?"}: ${code || err.message}`);
	});
	if (stderr) child.stderr?.on("data", (chunk: Buffer) => stderr(chunk.toString()));
	return child;
}

/** Return `options` with the safe spawner installed. Apply it to the final
 *  options object handed to query()/startup(), so the stderr callback it
 *  captures is the one that query actually uses. */
export function withSafeSpawn<T extends Options>(options: T, log?: (msg: string) => void): T {
	const stderr = options.stderr;
	return { ...options, spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => spawnClaudeCodeSafely(spawnOptions, stderr, log) };
}
