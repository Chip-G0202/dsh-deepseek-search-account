// Standalone end-to-end check for dsh-deepseek-search-account (dev tool, not
// shipped in the npm package).
//
// Runs the provider exactly as the harness would (stub ctx with the real
// DeepSeek account token read from ~/.dsh/.credentials.yaml), performs one real
// search, and prints a summary. The token never leaves this process.
//
// Usage (the app bundles a Node runtime):
//   NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
//   "$NODE" scripts/verify.mjs                          # official Search API (default)
//   "$NODE" scripts/verify.mjs "your query"
//   "$NODE" scripts/verify.mjs "your query" --messages  # legacy Messages server tool
//   "$NODE" scripts/verify.mjs --fetch "https://example.com"  # official Fetch API
//   "$NODE" scripts/verify.mjs --fetch-fallback "https://raw.githubusercontent.com/..." # official failure -> local fallback

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFetchProvider, createSearchProvider, FETCH_PROVIDER_ID, name as pluginName, PROVIDER_ID } from "../provider.js";

const args = process.argv.slice(2);
const messagesMode = args.includes("--messages");
const fetchMode = args.includes("--fetch");
const fetchFallbackMode = args.includes("--fetch-fallback");
const target = args.find((arg) => !arg.startsWith("--")) ?? (fetchMode ? "https://api-docs.deepseek.com/zh-cn/guides/search/" : "DeepSeek Harness");
const query = target;

function readAccountToken() {
	const file = join(homedir(), ".dsh", ".credentials.yaml");
	const text = readFileSync(file, "utf8");
	const match = text.match(/deepseek-account-platform\/default:\n(?:.*\n)*?\s+token:\s*(\S+)/u);
	return match?.[1];
}

const token = readAccountToken();
if (token === undefined) {
	console.error("no DeepSeek account token in ~/.dsh/.credentials.yaml — sign in to DeepSeek first");
	process.exit(2);
}

const ctx = {
	get(serviceName) {
		if (serviceName === "deepseekAccount") {
			return {
				resolveToken(endpoint) {
					const url = new URL(endpoint);
					return url.origin === "https://api.deepseek.com" ? token : undefined;
				}
			};
		}
		return undefined;
	}
};

// Stand-in for the shipped `http` fetch provider: proves the fallback wiring
// without loading the app bundle. It performs a plain local fetch.
const fakeHttpProvider = {
	id: "http",
	available: () => true,
	async fetch(request) {
		const response = await fetch(request.url);
		const content = await response.text();
		return { url: request.url, statusCode: response.status, body: { kind: "html", content }, truncated: false };
	}
};
ctx.web = { fetchProviders: new Map([["http", fakeHttpProvider]]) };

if (fetchFallbackMode) {
	const url = target === "DeepSeek Harness" ? "https://raw.githubusercontent.com/jasonxu114514/opencode2api/b13bf6989ce4a8bd8dbd681d33dfdd3205e04b78/docs/management.zh-CN.md" : target;
	const withFallback = createFetchProvider(ctx, {});
	const result = await withFallback.fetch({ url });
	console.log(`fallback=${"http"} statusCode=${result.statusCode} kind=${result.body.kind} chars=${result.body.content.length} url=${result.url}`);
	const disabled = createFetchProvider(ctx, { fallbackFetchProvider: "none" });
	let disabledError;
	try {
		await disabled.fetch({ url });
	} catch (error) {
		disabledError = error;
	}
	if (disabledError === undefined) {
		console.error("FAILED: fallbackFetchProvider: none still produced a result");
		process.exit(1);
	}
	console.log(`fallbackDisabledError=${disabledError.message.split("\n")[0]}`);
	console.log("OK");
	process.exit(0);
}

const config = messagesMode ? { mode: "messages" } : {};
const fetchProvider = createFetchProvider(ctx, config);

if (fetchMode) {
	console.log(`plugin=${pluginName} provider=${fetchProvider.id} available=${fetchProvider.available()} url=${JSON.stringify(target)}`);
	const startedAt = Date.now();
	const result = await fetchProvider.fetch({ url: target });
	const elapsed = Date.now() - startedAt;
	const content = result.body.content;
	console.log(
		`statusCode=${result.statusCode} bodyKind=${result.body.kind} chars=${content.length} truncated=${result.truncated} elapsedMs=${elapsed}`
	);
	console.log(`contentHead: ${content.slice(0, 240).replace(/\n/gu, "\\n")}`);
	if (content.length === 0) {
		console.error("FAILED: empty body");
		process.exit(1);
	}
	console.log("OK");
	process.exit(0);
}

const provider = createSearchProvider(ctx, config);
console.log(
	`plugin=${pluginName} provider=${provider.id} mode=${messagesMode ? "messages" : "search-api"} available=${provider.available()} query=${JSON.stringify(query)}`
);

const startedAt = Date.now();
const result = await provider.search({ query, maxResults: 8 });
const elapsed = Date.now() - startedAt;

console.log(`sources=${result.sources.length} truncated=${result.truncated} elapsedMs=${elapsed}`);
for (const source of result.sources.slice(0, 5)) {
	console.log(`- ${source.title ?? "(no title)"}`);
	console.log(`  ${source.url}`);
	if (source.snippet !== undefined) console.log(`  snippet(${source.snippet.length}): ${source.snippet.slice(0, 90)}…`);
	if (source.publishedAt !== undefined) console.log(`  publishedAt: ${source.publishedAt}`);
}
if (result.sources.length === 0) {
	console.error("FAILED: no sources returned");
	process.exit(1);
}
console.log("OK");
