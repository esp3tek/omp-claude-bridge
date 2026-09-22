import { test, expect } from "bun:test";
import { recordRateLimitEvent, buildUsageReport, __resetUsageWindows } from "../src/usage.ts";

const H = 3_600_000;

test("no window reported yet: nothing to report", () => {
  __resetUsageWindows();
  expect(buildUsageReport("claude-bridge")).toBeNull();
});

test("an event becomes a window the host can read", () => {
  __resetUsageWindows();
  const resets = new Date(Date.now() + 2 * H).toISOString();
  expect(recordRateLimitEvent({ rateLimitType: "five_hour", utilization: 42, resetsAt: resets })).toBe(true);
  const r = buildUsageReport("claude-bridge")!;
  expect(r.limits).toHaveLength(1);
  const [l] = r.limits;
  expect(l.id).toBe("claude-bridge:five_hour");
  expect(l.label).toBe("Claude 5 Hour");
  expect(l.amount.used).toBe(42);
  expect(l.amount.usedFraction).toBeCloseTo(0.42);
  expect(l.status).toBe("ok");
  expect(l.window.resetsAt).toBe(Date.parse(resets));
});

test("status crosses to warning at 90% and exhausted at 100%", () => {
  __resetUsageWindows();
  recordRateLimitEvent({ rateLimitType: "seven_day", utilization: 91 });
  expect(buildUsageReport("claude-bridge")!.limits[0].status).toBe("warning");
  recordRateLimitEvent({ rateLimitType: "seven_day", utilization: 100 });
  expect(buildUsageReport("claude-bridge")!.limits[0].status).toBe("exhausted");
});

test("a model-scoped weekly window keeps its own row and a readable label", () => {
  __resetUsageWindows();
  recordRateLimitEvent({ rateLimitType: "seven_day", utilization: 10 });
  recordRateLimitEvent({ rateLimitType: "seven_day_opus", utilization: 55 });
  const r = buildUsageReport("claude-bridge")!;
  expect(r.limits).toHaveLength(2);
  expect(r.limits.find((l) => l.window.id === "seven_day_opus")!.label).toBe("Claude 7 Day (opus)");
});

test("a window past its reset time is dropped", () => {
  __resetUsageWindows();
  recordRateLimitEvent({ rateLimitType: "five_hour", utilization: 80, resetsAt: new Date(Date.now() - 60_000).toISOString() });
  expect(buildUsageReport("claude-bridge")).toBeNull();
});

test("events without usable numbers are ignored", () => {
  __resetUsageWindows();
  expect(recordRateLimitEvent(undefined)).toBe(false);
  expect(recordRateLimitEvent({ status: "allowed" })).toBe(false);
  expect(buildUsageReport("claude-bridge")).toBeNull();
});

test("unifiedWindows (fraction of 1) records every window at once", () => {
  __resetUsageWindows();
  // Verbatim shape from Claude Code 2.1.278, with the epoch-second reset times
  // made relative so the test does not expire with the clock.
  const fiveHourReset = Math.floor(Date.now() / 1000) + 3 * 3600;
  const sevenDayReset = Math.floor(Date.now() / 1000) + 5 * 86400;
  const ok = recordRateLimitEvent({
    status: "allowed",
    resetsAt: fiveHourReset,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.21, resetsAt: fiveHourReset },
      seven_day: { utilization: 0.27, resetsAt: sevenDayReset },
    },
  });
  expect(ok).toBe(true);
  const r = buildUsageReport("claude-bridge")!;
  expect(r.limits).toHaveLength(2);
  expect(r.limits.find((l) => l.window.id === "five_hour")!.amount.used).toBeCloseTo(21);
  expect(r.limits.find((l) => l.window.id === "seven_day")!.amount.used).toBeCloseTo(27);
  expect(r.limits.find((l) => l.window.id === "five_hour")!.window.resetsAt).toBe(fiveHourReset * 1000);
});

test("a unifiedWindows value outside 0..1 is discarded, not reported as a percentage", () => {
  __resetUsageWindows();
  expect(recordRateLimitEvent({ unifiedWindows: { five_hour: { utilization: 42 } } })).toBe(false);
  expect(buildUsageReport("claude-bridge")).toBeNull();
});

test("without unifiedWindows the documented percentage pair is used", () => {
  __resetUsageWindows();
  expect(recordRateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 85 })).toBe(true);
  expect(buildUsageReport("claude-bridge")!.limits[0].amount.used).toBe(85);
});
