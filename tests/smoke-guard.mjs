// A smoke test succeeds only after its assertions AND a clean child shutdown.
export function smokeGuard(child, validate, timeoutMs) {
  let failure;
  const fail = (message) => {
    failure ??= String(message);
    console.error(`FAIL: ${message}`);
    child.kill();
  };
  const timeout = setTimeout(() => {
    fail("timeout");
    process.exit(2);
  }, timeoutMs);
  child.on("error", (error) => fail(error.message));
  child.stdin.on("error", (error) => fail(error.message));
  child.stderr.on("data", (data) => process.stderr.write(data));
  // 'close' comes after stdout is drained; 'exit' can precede the last events.
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    const problem = failure ?? (code !== 0 ? `omp exited ${code} (${signal ?? "no signal"})` : validate());
    if (problem) console.error(`FAIL: ${problem}`);
    process.exit(problem ? 1 : 0);
  });
  return {
    fail,
    observe(event) {
      if (event.type === "response" && event.success === false) {
        fail(`${event.command}: ${event.error ?? "RPC rejected"}`);
        return false;
      }
      if (event.type === "message_end" && event.message?.role === "assistant"
          && ["error", "aborted"].includes(event.message.stopReason)) {
        fail(event.message.errorMessage ?? event.message.stopReason);
        return false;
      }
      return !failure;
    },
  };
}
