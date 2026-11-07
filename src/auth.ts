// Claude Code reports a lost login as an is_error result, often with
// api_error_status null. Seen for real (2026-09-25, SystrayCentral):
// "Failed to authenticate: OAuth session expired and could not be refreshed".
// Other known forms: "Invalid API key · Please run /login", "Not logged in",
// "OAuth token has expired", "authentication_failed". Retrying cannot fix it:
// only a /login in an interactive Claude Code console does.
const AUTH_ERROR = /failed to authenticate|please run \/login|not logged in|invalid api key|oauth (token|session) (has )?(expired|revoked)|could not be refreshed|authentication_failed|authentication_error|invalid (x-api-key|bearer token)|token has been revoked/i;

export function isAuthError(text: string, apiStatus?: number | null): boolean {
	return apiStatus === 401 || AUTH_ERROR.test(text);
}

export const AUTH_ADVICE =
	"Claude Code lost its login (401). Open a terminal, run `claude`, and type /login, " +
	"then retry the turn. Retrying without logging in will fail the same way.";

/** Thrown for a lost Claude Code login; `status` lets the host classify it as
 *  a 401 instead of a transient error it would retry. */
export class ClaudeAuthError extends Error {
	readonly status = 401;
	constructor(message: string) {
		super(message);
		this.name = "ClaudeAuthError";
	}
}

// One notification per burst: side requests and retries hit the same wall.
const NOTIFY_INTERVAL_MS = 60_000;
let lastNotifyMs = 0;

export function shouldNotifyAuth(nowMs: number = Date.now()): boolean {
	if (nowMs - lastNotifyMs < NOTIFY_INTERVAL_MS) return false;
	lastNotifyMs = nowMs;
	return true;
}
