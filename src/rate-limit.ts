export const RATE_LIMIT_WARN_THRESHOLD = 80;

export interface RateLimitInfo {
	status?: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: string | number | Date;
}

export interface RateLimitNotice {
	message: string;
	level: "warning";
}

// The SDK emits `allowed_warning` rate-limit events even at trivial utilization
// (e.g. 1% of the seven_day window), so those are suppressed below the threshold;
// `rejected` (hard limit) always surfaces. Returns null when nothing should show.
export function rateLimitNotice(
	info: RateLimitInfo | undefined,
	threshold: number = RATE_LIMIT_WARN_THRESHOLD,
): RateLimitNotice | null {
	if (info?.status === "rejected") {
		const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
		return { message: `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, level: "warning" };
	}
	if (info?.status === "allowed_warning") {
		const utilization = Math.round(info.utilization ?? 0);
		if (utilization >= threshold) {
			return { message: `Claude rate limit warning: ${utilization}% used (${info.rateLimitType ?? ""})`, level: "warning" };
		}
	}
	return null;
}

/** Thrown when the Claude subscription quota is exhausted, so the host can
 *  classify the turn as a 429 usage-limit error and walk its fallback chain
 *  instead of ending the turn as a normal stop. */
export class ClaudeUsageLimitError extends Error {
	readonly status = 429;
	constructor(message: string) {
		super(message);
		this.name = "ClaudeUsageLimitError";
	}
}

/** SDK `resetsAt` is epoch seconds; tolerate epoch milliseconds and ISO strings. */
function resetsAtToMs(resetsAt: RateLimitInfo["resetsAt"]): number | undefined {
	if (resetsAt === undefined || resetsAt === null) return undefined;
	if (typeof resetsAt === "number") return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
	const ms = new Date(resetsAt).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

/** Builds a 429-style usage-limit error for a `rejected` rate-limit event, or
 *  null when the event is not a hard rejection. The message carries the
 *  `retry-after-ms=` hint the host parses for provider-timed resets. */
export function usageLimitError(info: RateLimitInfo | undefined, nowMs: number = Date.now()): ClaudeUsageLimitError | null {
	if (info?.status !== "rejected") return null;
	const resetMs = resetsAtToMs(info.resetsAt);
	const window = info.rateLimitType ?? "unknown";
	let message = `429 usage_limit_reached: Claude subscription ${window} quota exhausted`;
	if (resetMs !== undefined) {
		const retryAfterMs = Math.max(0, Math.round(resetMs - nowMs));
		message += ` — resets at ${new Date(resetMs).toISOString()} retry-after-ms=${retryAfterMs}`;
	}
	return new ClaudeUsageLimitError(message);
}
