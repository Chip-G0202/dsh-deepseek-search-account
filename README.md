# dsh-deepseek-search-account

[English](README.md) | [中文](README.zh.md)

A tiny DeepSeek Harness (DSH) plugin that keeps the built-in `web_search` tool working when your chat model is served by an **external, non-official subscription** — for example **OpenCode Go** (`opencode.ai/zen/go`), another Anthropic-compatible gateway, or a pi-ai provider — while DeepSeek Harness is signed in to a DeepSeek account.

Searches then run on the official DeepSeek Search API **using that DeepSeek account**, so `web_search` keeps working without a `DEEPSEEK_API_KEY`.

## When to use it / 适用情况

Use this plugin when **all** of the following are true:

- Your DSH chat model is served by a third-party subscription or gateway (OpenCode Go / Zen, another Anthropic-compatible endpoint, pi-ai, etc.), not by a DeepSeek Account model.
- You are signed in to a DeepSeek account in DSH (Settings → Account), and that account may be used for search.
- The built-in web search fails with `DeepSeek search has no API key for "DEEPSEEK_API_KEY"`, and you do not have (or do not want to use) a DeepSeek API key.

In that situation the harness keeps working as before, but `web_search` returns an error while `web_fetch` is fine. This plugin makes `web_search` use the official Search API with the signed-in account, so **search still runs on the DeepSeek account's official quota** and the chat subscription is untouched.

Do **not** install it when:

- Your chat model is a DeepSeek Account model: the shipped provider already searches with the account sign-in.
- You have a `DEEPSEEK_API_KEY` stored: the shipped provider already works (and the Search API can be enabled in Plugins → Built-in plugin settings → Web search).
- You already use another web-search provider plugin (Exa, Tavily, SearXNG, Zhipu, etc.) that suits you.

## Why it is needed

The shipped search providers (`dsh-web-search-deepseek`, `dsh-web-deepseek-api`) only use the DeepSeek account sign-in when the **initiating session's model route** is `deepseek-account`:

```js
ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider === "deepseek-account"
```

With OpenCode Go as the chat provider, that check fails, the provider falls back to the `DEEPSEEK_API_KEY` credential, and — with no key stored — `web_search` fails. This plugin resolves the same account token (`ctx.deepseekAccount.resolveToken(endpoint)`) on **every search**, without looking at the conversation's model route, and falls back to `DEEPSEEK_API_KEY` (Bearer) only when account sign-in is unavailable.

## What it does

- Registers a search provider named `deepseek-account-search` on the `ctx.web` seam.
- Calls the official DeepSeek Search API (`POST https://api.deepseek.com/v1/tools/search`) by default — one HTTP request per search, about 0.5–1 second, returning `title`, `url`, `snippet` and `date`; no auxiliary model turn, no extra model tokens.
- Keeps a legacy `mode: messages` backend (Anthropic-compatible Messages endpoint + the native `web_search_20250305` server tool) as an explicit fallback.
- Ships a bundle patch (`cordis.patch.yml`) that registers the provider and pins `web.searchProvider` to it while keeping `web.fetchProvider: http`.

## Install

### From GitHub into a profile

```bash
dsh plugin --profile desktop add github:Chip-G0202/dsh-deepseek-search-account
# for a plain `dsh web` server: --profile web
```

The package declares `dsh.bundle`, so `dsh plugin add` records it in the profile's bundles and applies `cordis.patch.yml` at boot — no hand-written row is needed. Installing from this check-out works the same way:

```bash
dsh plugin --profile desktop add /path/to/dsh-deepseek-search-account
```

Or attach the prebuilt tarball from the latest GitHub release:

```bash
dsh plugin --profile desktop add https://github.com/Chip-G0202/dsh-deepseek-search-account/releases/latest/download/dsh-deepseek-search-account.tgz
```

Then restart DSH (a profile bundle list change is applied on boot). For the Desktop app use the `desktop` profile as above.

### Manual install (file-path row)

If you prefer not to install a package, copy this folder somewhere stable and add two rows to the profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: web-search-deepseek-account
      name: '/path/to/dsh-deepseek-search-account/provider.js'
      config:
        mode: search-api
        count: 10
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-account-search
    fetchProvider: http
```

Note: DSH reloads profile configuration live, but it does not re-import a plugin module when only the module path of an existing row changes. After editing `provider.js`, restart DSH — or toggle the row `disabled: true` / back — to load the new code.

## Configuration

Installed as a bundle, the row lives in this package's `cordis.patch.yml`. Override it from the profile patch with an id-targeted entry that repeats the row name:

```yaml
- id: web-search-deepseek-account
  name: dsh-deepseek-search-account
  config:
    mode: search-api
    count: 8
```

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `search-api` | `search-api` = official Search API; `messages` = Anthropic Messages + `web_search_20250305` server tool |
| `baseURL` | `https://api.deepseek.com/v1/tools` | Search API base URL (`/search` is appended) |
| `count` | `10` | Results per Search API request, 1–50; the tool's `searchMaxResults` wins when smaller |
| `sendOriginalQuestion` | `true` | Send `ori_question` (the session's latest user prompt, ≤128 chars) |
| `apiKey` / `apiKeyEnv` | unset / `DEEPSEEK_API_KEY` | API-key fallback when account sign-in is unavailable |
| `messagesBaseURL` | `https://api.deepseek.com/anthropic/v1` | Only `mode: messages` (`/messages` is appended) |
| `model` | `deepseek-flash` | Only `mode: messages` |
| `apiVersion` | `2023-06-01` | Only `mode: messages` (ignored by DeepSeek, per its Anthropic-compatibility docs) |
| `maxTokens` | `4096` | Only `mode: messages` |
| `maxUses` | `5` | Only `mode: messages`, server-side searches per request |

## Billing and quotas

- The default `search-api` backend bills **per successful request**: 5 CNY / 1000 successful requests (about 0.005 CNY per search), charged to the DeepSeek account since 2026-11-01 00:00 Beijing time. Failed requests, empty results and timeouts are not billed. See the official [Search & Fetch guide](https://api-docs.deepseek.com/zh-cn/guides/search/).
- A search **does not consume chat-model tokens** and does not touch the subscription used for chatting (e.g. OpenCode Go). Only the DeepSeek account's search usage is involved.
- Latency is about 0.5–1 s per query.
- `mode: messages` is different: one search costs a full auxiliary model turn (thousands of input tokens, 4–6 s), and server-tool searches are also billed per call as of the same date. Use it only as a fallback.

## Security

- The DeepSeek account token is read from the DSH credential service per search (`ctx.deepseekAccount.resolveToken`) and sent only to the `api.deepseek.com` origin; the account service validates the origin.
- The plugin never writes the token to disk and never exposes it to the browser.
- No runtime dependencies, no install scripts: plain ESM using `node:` built-ins and the global `fetch`.

## Requirements

- DeepSeek Harness `0.2.1-rc.5` or later (the `ctx.web` seam and `deepseekAccount` service it relies on).
- Signed in to DeepSeek in DSH, with network access to `api.deepseek.com`.
- Node.js 22+ (the DSH desktop app bundles its own runtime).

## Verifying and troubleshooting

`scripts/verify.mjs` runs the provider exactly as the harness does, using the real account token from `~/.dsh/.credentials.yaml` (the token never leaves the process):

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
"$NODE" scripts/verify.mjs "query"              # official Search API, ~0.4–0.6 s, snippets included
"$NODE" scripts/verify.mjs "query" --messages   # legacy Messages backend, ~4–6 s
```

If search fails, the structured error names the cause: `WEB_PROVIDER_CREDENTIAL_MISSING` (not signed in and no API key), `WEB_PROVIDER_ERROR` (HTTP/network, with the endpoint that was used), or `WEB_ABORTED` (cancelled). If the account sign-in is rejected, sign in to DeepSeek again — the endpoint does not need changing.

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-deepseek-search-account
```

This removes the package and its bundle layer; the profile's own search configuration is not touched. For the manual install, delete the two rows described above.

## License

MIT
