/**
 * @local/dsh-deepseek-search-account
 *
 * A DeepSeek web-search provider for the harness `ctx.web` seam that keeps
 * `web_search` working when the conversation model is NOT a DeepSeek Account
 * model (OpenCode Go, pi-ai, etc.).
 *
 * Why this exists
 * ---------------
 * The shipped providers (`dsh-web-search-deepseek` / `dsh-web-deepseek-api`)
 * only use the DeepSeek account sign-in when the initiating session's model
 * route is `deepseek-account`:
 *
 *     ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider
 *
 * A session chatting through OpenCode Go therefore falls back to the
 * `DEEPSEEK_API_KEY` credential and fails with `WEB_PROVIDER_CREDENTIAL_MISSING`
 * when no key is stored. This provider resolves the SAME account token
 * (`ctx.deepseekAccount.resolveToken(endpoint)`) on every operation, without
 * looking at the conversation's model route, and falls back to a DeepSeek API
 * key when account sign-in is unavailable.
 *
 * Search backend
 * --------------
 * Primary (`mode: search-api`, the default): the official DeepSeek Search API
 * (`POST https://api.deepseek.com/v1/tools/search`, documented at
 * https://api-docs.deepseek.com/zh-cn/guides/search/) — one plain HTTP request,
 * about a second, no auxiliary model turn, returns `snippet` / `date` /
 * `summary`. Billed per successful request (5 元 / 1000 requests since
 * 2026-11-01 00:00 Beijing, see the official guide); requests that fail or
 * return no results are not billed.
 *
 * Legacy (`mode: messages`): the Anthropic-compatible Messages endpoint with
 * the native `web_search_20250305` server tool
 * (`POST https://api.deepseek.com/anthropic/v1/messages`). Matches the official
 * "使用 Anthropic API" guide, but each search costs a full auxiliary model turn
 * (thousands of input tokens plus output) and is slower.
 *
 * Fetch backend
 * -------------
 * The same row also registers a fetch provider (`deepseek-account-fetch`) so
 * `web_fetch` goes through the official Fetch API
 * (`POST https://api.deepseek.com/v1/tools/fetch`) instead of the shipped
 * anonymous `http` provider: one plain request, page content returned as
 * Markdown, billed on the same account quota (5 元 / 1000 successful requests
 * since 2026-11-01 00:00 Beijing; failed fetches are not billed). Set
 * `fetchEnabled: false` to leave `web_fetch` on the shipped provider.
 *
 * Authentication
 * --------------
 * Account sign-in first: `ctx.deepseekAccount.resolveToken(endpoint)` sent as
 * `x-dsh-auth-token` (the DeepSeek public Search/Fetch routes accept that
 * harness token; the same mechanism the shipped providers use for
 * account-routed sessions). Otherwise `DEEPSEEK_API_KEY` (credential store /
 * literal config / process environment) sent as `Authorization: Bearer <key>`
 * per the official docs.
 */

export const name = "web-search-deepseek-account";

/** The web seam this provider registers into. */
export const inject = ["web"];

/** Stable id this provider registers under. */
export const PROVIDER_ID = "deepseek-account-search";

/** Stable id the fetch provider registers under (`web.fetchProvider`). */
export const FETCH_PROVIDER_ID = "deepseek-account-fetch";

const DEFAULT_MODE = "search-api";
/** Search/Fetch API base, including the `/v1/tools` prefix; `/search` is appended. */
const DEFAULT_SEARCH_API_BASE_URL = "https://api.deepseek.com/v1/tools";
/** Anthropic-compatible Messages base, used by `mode: messages`. */
const DEFAULT_MESSAGES_BASE_URL = "https://api.deepseek.com/anthropic/v1";
/** Default result count for the Search API (1–50). */
const DEFAULT_COUNT = 10;
/** Model id used on `mode: messages` (official Anthropic-API guide vocabulary). */
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_USES = 5;
/** Default cap on the Markdown characters one fetch returns to the model. */
const DEFAULT_FETCH_MAX_CHARS = 100_000;
/** Default provider-side timeout for one Fetch API request (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Longest URL the Fetch API accepts, in characters. */
const FETCH_URL_MAX_CHARS = 8192;
/** Longest `ori_question` the Search API accepts, in characters. */
const ORIGINAL_QUESTION_MAX_CHARS = 128;
const SEARCH_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";
const MESSAGES_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";
const USER_AGENT = "deepseek-harness/0.0.1";

/** Build a selectable web error with the seam's machine-routable `code`. */
function webError(message, code, cause) {
	const error = new Error(message);
	error.name = "WebError";
	error.code = code;
	if (cause !== undefined) error.cause = cause;
	return error;
}

/** True for a fetch / AbortSignal abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return (error instanceof DOMException && error.name === "AbortError") || error?.name === "AbortError";
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw webError("DeepSeek search aborted", "WEB_ABORTED", signal.reason);
}

/** Read a trimmed, non-empty string from an environment variable. */
function envValue(key) {
	const value = process.env[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True for positive integral request limits. */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/** Resolve one operation's configuration snapshot from the row config. */
function readOptions(config) {
	const configuredBaseURL = typeof config.baseURL === "string" && config.baseURL.length > 0 ? config.baseURL : undefined;
	const messagesBaseURL =
		typeof config.messagesBaseURL === "string" && config.messagesBaseURL.length > 0 ? config.messagesBaseURL : undefined;
	const mode = config.mode === "messages" ? "messages" : DEFAULT_MODE;
	return {
		mode,
		searchBaseURL: (configuredBaseURL ?? envValue(SEARCH_BASE_URL_ENV) ?? DEFAULT_SEARCH_API_BASE_URL).replace(/\/+$/u, ""),
		messagesBaseURL: (messagesBaseURL ?? envValue(MESSAGES_BASE_URL_ENV) ?? DEFAULT_MESSAGES_BASE_URL).replace(/\/+$/u, ""),
		count: isPositiveInteger(config.count) ? Math.min(config.count, 50) : DEFAULT_COUNT,
		model: typeof config.model === "string" && config.model.length > 0 ? config.model : DEFAULT_MODEL,
		apiVersion: typeof config.apiVersion === "string" && config.apiVersion.length > 0 ? config.apiVersion : DEFAULT_API_VERSION,
		maxTokens: isPositiveInteger(config.maxTokens) ? config.maxTokens : DEFAULT_MAX_TOKENS,
		maxUses: isPositiveInteger(config.maxUses) ? config.maxUses : DEFAULT_MAX_USES,
		apiKey: typeof config.apiKey === "string" && config.apiKey.length > 0 ? config.apiKey : undefined,
		apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : "DEEPSEEK_API_KEY",
		sendOriginalQuestion: config.sendOriginalQuestion !== false,
		fetchMaxChars: isPositiveInteger(config.fetchMaxChars) ? config.fetchMaxChars : DEFAULT_FETCH_MAX_CHARS,
		fetchTimeoutMs: isPositiveInteger(config.fetchTimeoutMs) ? config.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS
	};
}

/** Bound `ori_question` to what the Search API accepts: single spaces, first 128 chars. */
function boundedQuestion(question) {
	const collapsed = question?.replace(/\s+/gu, " ").trim() ?? "";
	if (collapsed.length === 0) return undefined;
	return Array.from(collapsed).slice(0, ORIGINAL_QUESTION_MAX_CHARS).join("");
}

/**
 * Read the latest human prompt of the initiating session, the question that
 * triggered this turn (used as `ori_question`). Behaves like the shipped
 * provider: injected user-role context carries another source kind and is
 * skipped.
 */
function latestUserQuestion(ctx) {
	try {
		const session = ctx.get?.("agents")?.currentInitiator?.()?.session;
		const prompt = session?.deriveMessages?.().findLast(
			(message) => message.role === "user" && message.source?.kind === "user"
		);
		if (prompt === undefined) return undefined;
		return prompt.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	} catch {
		return undefined;
	}
}

/** Validate a Search API response and project its results into the seam's sources. */
function mapSearchResponse(payload) {
	if (typeof payload !== "object" || payload === null || !Array.isArray(payload.results)) {
		throw webError("DeepSeek Search API returned an invalid response body", "WEB_PROVIDER_ERROR");
	}
	const sources = [];
	for (const item of payload.results) {
		if (typeof item !== "object" || item === null) {
			throw webError("DeepSeek Search API returned an invalid response body", "WEB_PROVIDER_ERROR");
		}
		if (typeof item.url !== "string" || item.url.length === 0) {
			throw webError("DeepSeek Search API returned an invalid response body", "WEB_PROVIDER_ERROR");
		}
		if (item.date !== null && item.date !== undefined && typeof item.date !== "string") {
			throw webError("DeepSeek Search API returned an invalid response body", "WEB_PROVIDER_ERROR");
		}
		const source = { url: item.url };
		if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
		// `snippet` is the short (100–200 char) front-end excerpt; `summary` is the
		// longer (600–800 char) excerpt intended for models. Prefer the snippet and
		// fall back to the summary when the service supplies no snippet.
		const excerpt =
			typeof item.snippet === "string" && item.snippet.length > 0
				? item.snippet
				: typeof item.summary === "string" && item.summary.length > 0
					? item.summary
					: undefined;
		if (excerpt !== undefined) source.snippet = excerpt;
		if (typeof item.date === "string" && item.date.length > 0) source.publishedAt = item.date;
		sources.push(source);
	}
	return { sources, truncated: false };
}

/** Build a `url → cited_text` snippet map from Messages text-block citations. */
function citationSnippets(blocks) {
	const snippets = new Map();
	for (const block of blocks) {
		if (block?.type !== "text") continue;
		for (const citation of block.citations ?? []) {
			const url = citation?.url;
			const text = citation?.cited_text;
			if (typeof url === "string" && url.length > 0 && typeof text === "string" && text.length > 0 && !snippets.has(url)) {
				snippets.set(url, text);
			}
		}
	}
	return snippets;
}

/** Map a Messages response to the seam's normalized search result. */
function mapMessagesResponse(payload) {
	const blocks = Array.isArray(payload?.content) ? payload.content : [];
	const resultBlocks = blocks.filter((block) => block?.type === "web_search_tool_result");
	if (resultBlocks.length === 0) {
		throw webError(
			"DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search",
			"WEB_PROVIDER_ERROR"
		);
	}
	const snippets = citationSnippets(blocks);
	const seen = new Set();
	const sources = [];
	for (const block of resultBlocks) {
		for (const item of block.content ?? []) {
			if (item?.type !== "web_search_result" || typeof item.url !== "string" || item.url.length === 0) continue;
			if (seen.has(item.url)) continue;
			seen.add(item.url);
			const source = { url: item.url };
			if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
			const snippet = snippets.get(item.url);
			if (snippet !== undefined) source.snippet = snippet;
			if (typeof item.page_age === "string" && item.page_age.length > 0) source.publishedAt = item.page_age;
			sources.push(source);
		}
	}
	return { sources, truncated: false };
}

/**
 * Add endpoint guidance to failures that occur after the request dispatch
 * begins. `scope` is the operation (`search` or `fetch`), which decides both
 * the wording and the configuration knob named in the guidance.
 */
function endpointError(options, endpoint, message, cause, scope = "search") {
	const guidance =
		scope === "fetch"
			? "Fetch endpoint configuration is separate from chat; set the row's `baseURL`."
			: options.mode === "search-api"
				? "Search endpoint configuration is separate from chat; set the row's `baseURL` (or web-deepseek-api.baseURL if you use the shipped Search API provider)."
				: "Search endpoint configuration is separate from chat; set the row's `messagesBaseURL` (or web-search-deepseek.baseURL for the shipped provider).";
	return webError(`${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. ${guidance}`, "WEB_PROVIDER_ERROR", cause);
}

/** Guide the user to re-login when DeepSeek rejects the account token. */
function accountRejectedError(message) {
	return webError(
		`${message}\n\nDeepSeek rejected the account sign-in used for this web request. Sign in to DeepSeek again in the harness; ` +
			"the endpoint does not need changing.",
		"WEB_PROVIDER_ERROR"
	);
}

/** HTTP status-specific guidance from the public Search / Fetch error table. */
function statusMessage(scope, status, detail) {
	const label = scope === "fetch" ? "Fetch" : "Search";
	let message = `DeepSeek ${label} API error (HTTP ${status})${detail !== undefined ? `: ${detail}` : ""}`;
	if (status === 400) {
		message +=
			scope === "fetch"
				? "\n\nURL 不合法（必须是含 host 的 http/https 地址、不能携带用户名或密码、长度不超过 8192）。"
				: "\n\n请求参数不合法（query 长度 1–128 字符、count 1–50 等）。";
	}
	if (status === 401) message += "\n\nAPI Key 缺失或无效。";
	if (status === 402) message += "\n\nDeepSeek 账号余额不足，请先充值（Search/Fetch 按成功请求计费，目前 5 元/1000 次）。";
	if (status === 403 && scope === "fetch") message += "\n\nFetch 请求被安全策略拒绝。";
	if (status === 404 && scope === "fetch") {
		message += "\n\nFetch 未能获取可用的网页内容（URL 不可用、被站点策略拦截、目标站点返回错误、内容类型不受支持或页面没有可提取的 Markdown 正文）。";
	}
	if (status === 408) message += "\n\n读取请求体超时，请稍后重试。";
	if (status === 413) message += "\n\n请求体超过大小限制。";
	if (status === 429) message += "\n\n超过 Search/Fetch 的账号级 QPS 限制（Search 100 QPS、Fetch 25 QPS），请稍后重试。";
	if (status >= 500) message += "\n\n服务端错误，请稍后重试。";
	return message;
}

/** Read one host service without letting a missing/disabled service throw. */
function serviceNamed(ctx, serviceName) {
	try {
		return ctx.get?.(serviceName);
	} catch {
		return undefined;
	}
}

/** Resolve the DeepSeek API key from row config, the credentials service, or the environment. */
async function resolveApiKey(ctx, options, signal) {
	throwIfAborted(signal);
	if (options.apiKey !== undefined) return options.apiKey;
	const credentials = serviceNamed(ctx, "credentials");
	if (credentials !== undefined && typeof credentials.resolve === "function") {
		const resolved = await credentials.resolve(options.apiKeyEnv);
		const value = resolved?.value;
		if (typeof value === "string" && value.length > 0) return value;
	}
	return envValue(options.apiKeyEnv);
}

/**
 * Resolve authentication for one operation: account sign-in first (sent as
 * `x-dsh-auth-token`, which the public Search/Fetch routes accept), then the
 * DeepSeek API key (the official docs' Bearer scheme).
 */
async function resolveAuth(ctx, endpoint, options, signal) {
	throwIfAborted(signal);
	const account = serviceNamed(ctx, "deepseekAccount");
	if (account !== undefined && typeof account.resolveToken === "function") {
		try {
			const token = await account.resolveToken(endpoint);
			if (typeof token === "string" && token.length > 0) {
				return { kind: "account", headers: { "x-dsh-auth-token": token } };
			}
		} catch {
			// Fall through to the API key; an account failure alone is not fatal.
		}
	}
	throwIfAborted(signal);
	const apiKey = await resolveApiKey(ctx, options, signal);
	if (apiKey === undefined) {
		throw webError(
			`DeepSeek web access has no account sign-in and no API key for "${options.apiKeyEnv}"; ` +
				"sign in to DeepSeek (search and fetch then use the account sign-in), or store the key through the credentials service " +
				"(the web Models page writes it), export it in the launching environment, or set a literal `apiKey` in the row config",
			"WEB_PROVIDER_CREDENTIAL_MISSING"
		);
	}
	return { kind: "api-key", headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } };
}

/**
 * Dispatch one JSON POST to the DeepSeek Search/Fetch API and return the parsed
 * body. `scope` selects the operation-specific wording of failures.
 */
async function postJson(endpoint, headers, body, signal, authKind, options, scope = "search") {
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				...headers,
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": USER_AGENT
			},
			body: JSON.stringify(body),
			...(signal !== undefined ? { signal } : {})
		});
	} catch (error) {
		if (error?.name === "TimeoutError") throw webError(`DeepSeek ${scope} request timed out`, "WEB_FETCH_TIMEOUT", error);
		if (signal?.aborted === true || isAbortError(error)) throw webError(`DeepSeek ${scope} aborted`, "WEB_ABORTED", error);
		throw endpointError(options, endpoint, `DeepSeek ${scope} request failed: ${String(error)}`, error, scope);
	}
	if (!response.ok) {
		let detail;
		try {
			const parsed = await response.json();
			detail = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw webError(`DeepSeek ${scope} aborted`, "WEB_ABORTED", error);
		}
		if (response.status === 401 && authKind === "account") throw accountRejectedError(statusMessage(scope, 401, detail));
		throw endpointError(options, endpoint, statusMessage(scope, response.status, detail), undefined, scope);
	}
	try {
		return await response.json();
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) throw webError(`DeepSeek ${scope} aborted`, "WEB_ABORTED", error);
		throw endpointError(options, endpoint, `DeepSeek returned an unprocessable response body: ${String(error)}`, error, scope);
	}
}

/**
 * Create the DeepSeek-account-backed search provider.
 *
 * @param ctx - plugin context; `ctx.get("deepseekAccount")` and
 *   `ctx.get("credentials")` are read lazily on every operation so sign-in and
 *   key rotation take effect without a reload.
 * @param config - the row config (mode/baseURL/count/apiKey/apiKeyEnv/model/...).
 */
export function createSearchProvider(ctx, config = {}) {

	/** One official Search API call (`POST /v1/tools/search`). */
	const searchViaSearchApi = async (request, options, signal) => {
		const endpoint = `${options.searchBaseURL}/search`;
		const auth = await resolveAuth(ctx, endpoint, options, signal);
		const count = Math.max(1, Math.min(options.count, request.maxResults ?? options.count, 50));
		const question = options.sendOriginalQuestion ? boundedQuestion(latestUserQuestion(ctx)) : undefined;
		const body = {
			query: request.query,
			count,
			need_content: false,
			...(question !== undefined ? { ori_question: question } : {})
		};
		return mapSearchResponse(await postJson(endpoint, auth.headers, body, signal, auth.kind, options));
	};

	/** One legacy Anthropic-Messages turn with the native `web_search` server tool. */
	const searchViaMessages = async (request, options, signal) => {
		const endpoint = `${options.messagesBaseURL}/messages`;
		const auth = await resolveAuth(ctx, endpoint, options, signal);
		const body = {
			model: options.model,
			max_tokens: options.maxTokens,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `Perform a web search for the query: ${request.query}` }]
				}
			],
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: options.maxUses }],
			thinking: { type: "disabled" }
		};
		const payload = await postJson(endpoint, { ...auth.headers, "anthropic-version": options.apiVersion }, body, signal, auth.kind, options);
		return mapMessagesResponse(payload);
	};

	return {
		id: PROVIDER_ID,

		/** Availability is a cheap local check; the real credential check happens per search. */
		available() {
			const options = readOptions(config);
			return (
				Boolean(serviceNamed(ctx, "deepseekAccount") ?? serviceNamed(ctx, "credentials")) ||
				envValue(options.apiKeyEnv) !== undefined ||
				options.apiKey !== undefined
			);
		},

		/** Run one search through the configured backend. */
		async search(request, signal) {
			const options = readOptions(config);
			throwIfAborted(signal);
			return options.mode === "messages"
				? await searchViaMessages(request, options, signal)
				: await searchViaSearchApi(request, options, signal);
		}
	};
}

/** Validate a URL the official Fetch API will accept. */
function validateFetchUrl(url) {
	if (typeof url !== "string" || url.length === 0) throw webError("web fetch needs a URL", "WEB_INVALID_URL");
	if (url.length > FETCH_URL_MAX_CHARS) {
		throw webError(`URL is longer than the ${FETCH_URL_MAX_CHARS} characters the Fetch API accepts`, "WEB_INVALID_URL");
	}
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw webError(`invalid URL ${JSON.stringify(url)}`, "WEB_INVALID_URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw webError(`unsupported URL scheme "${parsed.protocol}" (only http/https can be fetched)`, "WEB_INVALID_URL");
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw webError("URL must not carry a username or password", "WEB_INVALID_URL");
	}
	return parsed;
}

/** Combine the caller's cancellation signal with the provider's own timeout. */
function withFetchTimeout(signal, timeoutMs) {
	if (typeof AbortSignal.timeout !== "function") return signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	if (signal === undefined) return timeout;
	return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

/**
 * Create the DeepSeek-account-backed fetch provider.
 *
 * Registers as `deepseek-account-fetch` for `ctx.web.fetch()`: one call to the
 * official Fetch API, page body returned as the seam's `text` body (already
 * Markdown), so `web_fetch` renders it verbatim instead of converting HTML.
 * The same account sign-in (or `DEEPSEEK_API_KEY`) used for search authenticates
 * the request, and a successful fetch is billed on the same account quota.
 *
 * @param ctx - plugin context; sign-in and credentials are read lazily per fetch.
 * @param config - the row config (baseURL/fetchMaxChars/fetchTimeoutMs/apiKey/...).
 */
export function createFetchProvider(ctx, config = {}) {
	return {
		id: FETCH_PROVIDER_ID,

		/** Availability is a cheap local check; credentials are resolved per fetch. */
		available() {
			const options = readOptions(config);
			return (
				Boolean(serviceNamed(ctx, "deepseekAccount") ?? serviceNamed(ctx, "credentials")) ||
				envValue(options.apiKeyEnv) !== undefined ||
				options.apiKey !== undefined
			);
		},

		/** Fetch one URL through the official Fetch API (`POST /v1/tools/fetch`). */
		async fetch(request, signal) {
			const options = readOptions(config);
			throwIfAborted(signal);
			const target = validateFetchUrl(request?.url);
			const endpoint = `${options.searchBaseURL}/fetch`;
			const auth = await resolveAuth(ctx, endpoint, options, signal);
			const effectiveSignal = withFetchTimeout(signal, options.fetchTimeoutMs);
			const payload = await postJson(
				endpoint,
				auth.headers,
				{ url: target.toString() },
				effectiveSignal,
				auth.kind,
				options,
				"fetch"
			);
			if (typeof payload?.content !== "string" || payload.content.length === 0) {
				throw webError("DeepSeek Fetch API returned no page content", "WEB_PROVIDER_ERROR");
			}
			const content = payload.content.slice(0, options.fetchMaxChars);
			return {
				url: target.toString(),
				statusCode: 200,
				body: { kind: "text", content },
				truncated: content.length !== payload.content.length
			};
		}
	};
}

/** Register the search and fetch providers with `ctx.web`. */
export function apply(ctx, config) {
	const rowConfig = config ?? {};
	ctx.web.registerSearchProvider(createSearchProvider(ctx, rowConfig));
	ctx.web.registerFetchProvider(createFetchProvider(ctx, rowConfig));
}
