// Offline child process used by smoke-scripts.test.mjs. Never starts omp.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const [target, scenario] = process.argv.slice(2);
const name = basename(target);
const require = createRequire(import.meta.url);
const realSetTimeout = globalThis.setTimeout;
// Skip deliberate between-turn delays, keeping the watchdog active.
globalThis.setTimeout = (fn, ms, ...args) => ms <= 4000 ? setImmediate(fn, ...args) : realSetTimeout(fn, 5000, ...args);
require("node:child_process").spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false, pendingSwitch = false;
  const close = (code) => {
    if (closed) return;
    closed = true;
    child.emit("exit", code, null);
    child.emit("close", code, null);
  };
  const emit = (event) => {
    if (!closed) child.stdout.write(JSON.stringify(event) + "\n");
  };
  child.kill = () => { setImmediate(() => close(1)); return true; };
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const command = JSON.parse(chunk.toString());
      if (command.type === "prompt" && pendingSwitch) {
        emit({ type: "response", command: "prompt", success: false, error: "prompt sent before model acknowledgement" });
      }
      if (command.type === "set_model") pendingSwitch = true;
      setImmediate(() => {
        const success = !(scenario === "rpc-error" && ["prompt", "compact", "set_model"].includes(command.type))
          && !(scenario === "compact-error" && command.type === "compact")
          && !(scenario === "switch-error" && command.type === "set_model");
        if (command.type === "set_model") pendingSwitch = false;
        emit({ type: "response", id: command.id, command: command.type, success, error: success ? undefined : "simulated error" });
        if (!success || command.type !== "prompt") return;
        let text = "OK";
        if (name === "prewarm-test.mjs") text = ["OK", "OK2", "OK3"][Number(command.id.slice(1))];
        if (name === "compact-test.mjs" && command.id === "p1") text = "MANDARINA";
        if (name === "switch-test.mjs" && command.id === "p2") text = "KIWI";
        if (name === "subagent-test.mjs") {
          if (command.id === "p0" && scenario !== "missing-tool") emit({ type: "tool_execution_start", toolName: "task" });
          if (command.id === "p1") text = "NISPERO";
        }
        if (scenario === "wrong-answer") text = "NO RECUERDO";
        const message = { role: "assistant", content: [{ type: "text", text }], stopReason: scenario === "assistant-error" ? "error" : "stop" };
        emit({ type: "message_update", message });
        emit({ type: "message_end", message });
        emit({ type: "agent_end" });
      });
      callback();
    },
    final(callback) { setImmediate(() => close(scenario === "late-crash" ? 7 : 0)); callback(); },
  });
  setImmediate(() => {
    if (scenario === "crash") close(7);
    else if (scenario === "early-exit") close(0);
    else if (scenario === "spawn-error") { child.emit("error", new Error("ENOENT simulated")); }
    else emit({ type: "ready" });
  });
  return child;
};
syncBuiltinESMExports();
// Prevent the fixture arguments from becoming the smoke script's model name.
process.argv = [process.execPath, target];
await import(pathToFileURL(target).href);
