// Subscription quota for the claude-bridge provider.
//
// omp polls every registered provider's `usage` resolver and feeds the result
// to `omp usage`, the status bar and `retry.usageAwareFallback`. The bridge has
// no credential of its own — Claude Code owns the OAuth session — so this reads
// the token Claude Code keeps in `<CLAUDE_CONFIG_DIR>/.credentials.json` and
// asks Anthropic's OAuth usage endpoint, exactly like Claude Code's `/usage`.
// Claude Code refreshes that token every time the bridge runs a turn, so a
// stale token only means one failed poll.
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

interface UsageBucket {
	utilization?: number | null;
	resets_at?: string | null;
}

interface ClaudeUsageResponse {
	five_hour?: UsageBucket | null;
	seven_day?: UsageBucket | null;
	seven_day_opus?: UsageBucket | null;
	seven_day_sonnet?: UsageBucket | null;
	seven_day_fable?: UsageBucket | null;
}

// Shapes mirrored from @oh-my-pi/pi-ai `usage.ts` (not importable here: omp
// ships as a single binary). Only the fields the host reads.
export interface UsageLimitRow {
	id: string;
	label: string;
	scope: { provider: string; windowId: string; shared?: boolean; tier?: string };
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

export function readClaudeOAuthToken(claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): { accessToken: string; subscriptionType?: string } | null {
	try {
		const raw = JSON.parse(readFileSync(join(claudeDir, ".credentials.json"), "utf8")) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string } };
		const token = raw.claudeAiOauth?.accessToken;
		return token ? { accessToken: token, subscriptionType: raw.claudeAiOauth?.subscriptionType } : null;
	} catch {
		return null;
	}
}

function row(provider: string, id: string, label: string, windowId: string, windowLabel: string, durationMs: number, bucket: UsageBucket | null | undefined, tier?: string): UsageLimitRow | null {
	if (!bucket || bucket.utilization == null) return null;
	const used = Math.min(Math.max(bucket.utilization, 0), 100);
	const usedFraction = used / 100;
	const resetsAt = bucket.resets_at ? Date.parse(bucket.resets_at) : NaN;
	return {
		id,
		label,
		scope: { provider, windowId, ...(tier ? { tier } : { shared: true }) },
		window: { id: windowId, label: windowLabel, durationMs, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) },
		amount: { used, limit: 100, remaining: 100 - used, usedFraction, remainingFraction: 1 - usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok",
	};
}

/** Pure: turn the OAuth usage payload into the host's report shape. */
export function buildClaudeUsageReport(provider: string, payload: ClaudeUsageResponse, fetchedAt = Date.now(), subscriptionType?: string): UsageReportShape {
	const limits = [
		row(provider, `${provider}:5h`, "Claude 5 Hour", "5h", "5 Hour", 5 * HOUR_MS, payload.five_hour),
		row(provider, `${provider}:7d`, "Claude 7 Day", "7d", "7 Day", WEEK_MS, payload.seven_day),
		row(provider, `${provider}:7d:opus`, "Claude 7 Day (Opus)", "7d", "7 Day", WEEK_MS, payload.seven_day_opus, "opus"),
		row(provider, `${provider}:7d:sonnet`, "Claude 7 Day (Sonnet)", "7d", "7 Day", WEEK_MS, payload.seven_day_sonnet, "sonnet"),
		row(provider, `${provider}:7d:fable`, "Claude 7 Day (Fable)", "7d", "7 Day", WEEK_MS, payload.seven_day_fable, "fable"),
	].filter((r): r is UsageLimitRow => r !== null);
	return {
		provider,
		fetchedAt,
		limits,
		...(subscriptionType ? { notes: [`Claude plan: ${subscriptionType}`] } : {}),
	};
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Fetch the subscription usage with Claude Code's own OAuth token. Returns
 *  null (not an error) when there is no token or the endpoint refuses it, so
 *  the host keeps its last good report. */
export async function fetchClaudeUsage(provider: string, fetchImpl: FetchLike, signal?: AbortSignal, log?: (msg: string) => void): Promise<UsageReportShape | null> {
	const token = readClaudeOAuthToken();
	if (!token) { log?.("usage: no Claude Code OAuth token found"); return null; }
	const response = await fetchImpl(USAGE_ENDPOINT, {
		headers: { authorization: `Bearer ${token.accessToken}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
		signal,
	});
	if (!response.ok) { log?.(`usage: endpoint answered ${response.status}`); return null; }
	const payload = (await response.json()) as ClaudeUsageResponse;
	const report = buildClaudeUsageReport(provider, payload, Date.now(), token.subscriptionType);
	log?.(`usage: ${report.limits.map((l) => `${l.window.id}${l.scope.tier ? `/${l.scope.tier}` : ""}=${l.amount.used}%`).join(" ")}`);
	return report;
}
