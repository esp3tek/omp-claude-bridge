// Subscription quota, reported to the host from what the SDK tells us.
//
// Everything here comes from `rate_limit_event` messages the Claude Agent SDK
// emits during a turn: the window they apply to, how much of it is used, and
// when it resets. Nothing in this file reads credentials, and nothing talks to
// Anthropic — the extension's only channel to the service is Claude Code
// itself, through the SDK. Reading Claude Code's OAuth token to call the usage
// endpoint directly would work and would fill the numbers in sooner, but it
// would use the credential outside the client it was issued to, which is
// exactly what this bridge exists to avoid.
//
// The cost of staying inside the SDK is that a window is unknown until a turn
// has reported it: a fresh process shows no quota until its first turn ends.

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** `rate_limit_info` as the SDK delivers it.
 *
 *  Two sources of numbers, on different scales:
 *
 *  - `utilization` is the documented field (`SDKRateLimitInfo`), a percentage,
 *    and it only accompanies the window named by `rateLimitType`. On a plain
 *    `status: "allowed"` event it is usually absent.
 *  - `unifiedWindows` is not in the SDK's types — Claude Code 2.1.278 sends it
 *    on every rate-limit event — and carries every window at once as a
 *    fraction of 1. It is the useful one, so it is read defensively: a value
 *    outside 0..1 is discarded rather than reported as a wrong percentage.
 */
export interface RateLimitEvent {
	status?: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: string | number | Date;
	unifiedWindows?: Record<string, { utilization?: number; resetsAt?: string | number | Date } | null>;
}

// Shapes mirrored from @oh-my-pi/pi-ai's `usage.ts` (not importable here: omp
// ships as a single binary). Only the fields the host reads.
export interface UsageLimitRow {
	id: string;
	label: string;
	scope: { provider: string; windowId: string; shared: boolean };
	window: { id: string; label: string; durationMs: number; resetsAt?: number };
	amount: { used: number; limit: number; remaining: number; usedFraction: number; remainingFraction: number; unit: "percent" };
	status: "ok" | "warning" | "exhausted";
}

export interface UsageReportShape {
	provider: string;
	fetchedAt: number;
	limits: UsageLimitRow[];
	notes?: string[];
}

interface KnownWindow {
	id: string;
	label: string;
	durationMs: number;
	utilization: number;
	resetsAt?: number;
	observedAt: number;
}

// Claude Code names its windows `five_hour` / `seven_day`, sometimes with a
// model-family suffix. Anything unrecognized is still reported, with its own id.
const WINDOW_SHAPES: Record<string, { label: string; durationMs: number }> = {
	five_hour: { label: "Claude 5 Hour", durationMs: 5 * HOUR_MS },
	seven_day: { label: "Claude 7 Day", durationMs: WEEK_MS },
};

function windowShape(rateLimitType: string): { label: string; durationMs: number } {
	const known = WINDOW_SHAPES[rateLimitType];
	if (known) return known;
	const weekly = rateLimitType.startsWith("seven_day");
	const suffix = rateLimitType.replace(/^(seven_day|five_hour)_?/, "").replace(/_/g, " ").trim();
	return {
		label: `Claude ${weekly ? "7 Day" : "5 Hour"}${suffix ? ` (${suffix})` : ""}`,
		durationMs: weekly ? WEEK_MS : 5 * HOUR_MS,
	};
}

function resetsAtToMs(resetsAt: RateLimitEvent["resetsAt"]): number | undefined {
	if (resetsAt === undefined || resetsAt === null) return undefined;
	if (typeof resetsAt === "number") return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
	const ms = new Date(resetsAt).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

/** Windows seen so far, newest reading per window. Process-wide: every session
 *  in this process shares one subscription. */
const windows = new Map<string, KnownWindow>();

function remember(type: string, percent: number, resetsAt: RateLimitEvent["resetsAt"]): void {
	const shape = windowShape(type);
	windows.set(type, {
		id: type,
		label: shape.label,
		durationMs: shape.durationMs,
		utilization: Math.min(Math.max(percent, 0), 100),
		resetsAt: resetsAtToMs(resetsAt),
		observedAt: Date.now(),
	});
}

/** Record a `rate_limit_event`. Returns true when it carried usable numbers. */
export function recordRateLimitEvent(info: RateLimitEvent | undefined): boolean {
	if (!info) return false;
	let recorded = false;

	for (const [type, w] of Object.entries(info.unifiedWindows ?? {})) {
		const fraction = w?.utilization;
		// Fractions only: anything above 1 is a scale this code does not know.
		if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
		remember(type, fraction * 100, w?.resetsAt);
		recorded = true;
	}
	if (recorded) return true;

	// Fall back to the documented single-window pair, which is a percentage.
	const type = info.rateLimitType;
	if (!type || typeof info.utilization !== "number" || !Number.isFinite(info.utilization)) return false;
	remember(type, info.utilization, info.resetsAt);
	return true;
}

/** A window whose reset time has passed carries no information any more. */
function isStale(w: KnownWindow, now: number): boolean {
	if (w.resetsAt !== undefined) return w.resetsAt <= now;
	return now - w.observedAt > w.durationMs;
}

/** The report the host asks for, or null when no turn has reported a window yet
 *  (the host then keeps whatever it had). */
export function buildUsageReport(provider: string, now = Date.now()): UsageReportShape | null {
	const limits: UsageLimitRow[] = [];
	for (const w of windows.values()) {
		if (isStale(w, now)) { windows.delete(w.id); continue; }
		const usedFraction = w.utilization / 100;
		limits.push({
			id: `${provider}:${w.id}`,
			label: w.label,
			scope: { provider, windowId: w.id, shared: true },
			window: { id: w.id, label: w.label, durationMs: w.durationMs, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) },
			amount: {
				used: w.utilization,
				limit: 100,
				remaining: 100 - w.utilization,
				usedFraction,
				remainingFraction: 1 - usedFraction,
				unit: "percent",
			},
			status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok",
		});
	}
	if (!limits.length) return null;
	return {
		provider,
		fetchedAt: now,
		limits,
		notes: ["Reported by Claude Code during the last turn; windows appear once a turn has reported them."],
	};
}

/** Test seam. */
export function __resetUsageWindows(): void {
	windows.clear();
}
