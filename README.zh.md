# dsh-deepseek-search-account

[English](README.md) | 中文

一个很小的 DeepSeek Harness（DSH）插件：**当你的聊天模型接的是外部非官方订阅/网关（例如 OpenCode Go、其他 Anthropic 兼容网关、pi-ai 等），只要 DSH 里已登录 DeepSeek 账号，内置 `web_search` 和 `web_fetch` 就仍然可用——搜索走官方 Search API、抓取走官方 Fetch API，都使用该账号的官方额度，不需要 `DEEPSEEK_API_KEY`。**

## 适用情况

**推荐在这些条件下使用：**

- DSH 的聊天模型由第三方订阅/网关提供（OpenCode Go / Zen、其他 Anthropic 兼容端点、pi-ai 等），不是 DeepSeek 账号模型；
- 你已在 DSH 里登录 DeepSeek 账号（设置 → 账号），并且愿意让该账号承担搜索/抓取调用；
- 内置网页搜索报错 `DeepSeek search has no API key for "DEEPSEEK_API_KEY"`，而你手上没有、或不想用 DeepSeek API Key。

这时 `web_search` 不可用（`web_fetch` 原本走本地匿名 HTTP）。装上本插件后，**搜索与抓取都走 DeepSeek 官方额度和官方 Search/Fetch API**，聊天所用的订阅（如 OpenCode GO）完全不受影响、也不会被消耗。

**不需要安装的情况：**

- 聊天模型本身就是 DeepSeek 账号模型——官方提供方已经会用账号登录搜索；
- 你已经配置了 `DEEPSEEK_API_KEY`——官方提供方本来就可用（也可以在「插件 → 内置插件配置 → 网页搜索」里启用新版 Search API）；
- 你已经在用其他搜索提供方插件（Exa、Tavily、SearXNG、智谱等）并已满足需求。

## 为什么需要它

DSH 自带的搜索提供方（`dsh-web-search-deepseek`、`dsh-web-deepseek-api`）**只在「发起搜索的会话」模型路由为 `deepseek-account` 时**才使用 DeepSeek 账号登录：

```js
ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider === "deepseek-account"
```

聊天走 OpenCode Go 时这个判断不成立，提供方转而解析 `DEEPSEEK_API_KEY`；没有 key 就报错。本插件在**每次搜索和抓取**时直接取 `ctx.deepseekAccount.resolveToken(endpoint)`，不看聊天模型路由；只有账号登录不可用时才回退到 `DEEPSEEK_API_KEY`（Bearer）。

## 它做什么

- 在 `ctx.web` seam 上注册搜索提供方 `deepseek-account-search` 和抓取提供方 `deepseek-account-fetch`；
- 默认走 **DeepSeek 官方 Search API**（`POST https://api.deepseek.com/v1/tools/search`）：一次请求约 0.5–1 秒，返回 `title` / `url` / `snippet` / `date`，不产生辅助模型轮次、不消耗模型 token；
- `web_fetch` 走 **DeepSeek 官方 Fetch API**（`POST https://api.deepseek.com/v1/tools/fetch`）：一次请求，返回 Markdown 正文，替代自带的匿名 `http` 抓取；
- 官方抓取失败（HTTP 403/404、纯文本文件、无法提取正文）时，自动回退到本机挂载的 `http` 提供方，保证这类 URL 仍可抓取；把 `fallbackFetchProvider` 设为 `none` 可关闭回退；
- 保留旧的 `mode: messages` 搜索后端（Anthropic 兼容 Messages + 原生 `web_search_20250305` 服务端工具）作为显式回退；
- 自带 bundle 补丁 `cordis.patch.yml`：注册两个提供方，并把 `web.searchProvider` / `web.fetchProvider` 都固定到它们。

## 安装

### 从 GitHub 装进某个 profile

```bash
dsh plugin --profile desktop add github:Chip-G0202/dsh-deepseek-search-account
# 纯 `dsh web` 服务则用 --profile web
```

包内声明了 `dsh.bundle`，所以 `dsh plugin add` 会把它记录进 profile 的 bundles 并在启动时应用自带的 `cordis.patch.yml`，不需要手工写行。直接用本地目录安装也一样：

```bash
dsh plugin --profile desktop add /path/to/dsh-deepseek-search-account
```

也可以直接装 GitHub Release 里的预构建 tarball：

```bash
dsh plugin --profile desktop add https://github.com/Chip-G0202/dsh-deepseek-search-account/releases/latest/download/dsh-deepseek-search-account.tgz
```

装完**重启 DSH**（bundle 列表变化在启动时生效）。桌面版用 `desktop` profile，同上。

### 手工安装（文件路径行）

不想装包的话，把本目录放到一个固定路径，然后在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里加两段：

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
    fetchProvider: deepseek-account-fetch
```

如果只想让搜索走官方、抓取仍用本地匿名 HTTP：把 `fetchProvider` 改成 `http` 即可。

注意：DSH 的配置热更新**不会因为同一行插件模块路径变化而重新 import 模块**。改了 `provider.js` 之后要重启 DSH，或把该行临时改成 `disabled: true` 保存、再改回来，才会加载新代码。

## 配置

以 bundle 方式安装时，插件行位于本包的 `cordis.patch.yml` 中。如需覆盖，在 profile 补丁里写一个 id 定向覆盖（要带上同样的 `name`）：

```yaml
- id: web-search-deepseek-account
  name: dsh-deepseek-search-account
  config:
    mode: search-api
    count: 8
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `search-api` | 搜索后端：`search-api` = 官方 Search API；`messages` = Anthropic Messages + `web_search_20250305` 服务端工具 |
| `baseURL` | `https://api.deepseek.com/v1/tools` | Search/Fetch API 基址（分别追加 `/search`、`/fetch`） |
| `count` | `10` | 每次 Search API 请求的条数，1–50；工具侧 `searchMaxResults` 更小时以更小者为准 |
| `sendOriginalQuestion` | `true` | 是否发送 `ori_question`（会话最近一条用户提问，≤128 字符） |
| `fetchMaxChars` | `100000` | 单次抓取返回的 Markdown 字符上限（超出会标记 truncated） |
| `fetchTimeoutMs` | `30000` | 单次 Fetch API 请求的提供方超时 |
| `fallbackFetchProvider` | `http` | 官方抓取无法获取页面时使用的本机提供方；`none` 表示不回退 |
| `apiKey` / `apiKeyEnv` | 未设置 / `DEEPSEEK_API_KEY` | 账号登录不可用时的 API Key 回退 |
| `messagesBaseURL` | `https://api.deepseek.com/anthropic/v1` | 仅 `mode: messages`（追加 `/messages`） |
| `model` | `deepseek-flash` | 仅 `mode: messages` |
| `apiVersion` | `2023-06-01` | 仅 `mode: messages`（官方文档说明该头会被忽略） |
| `maxTokens` | `4096` | 仅 `mode: messages` |
| `maxUses` | `5` | 仅 `mode: messages`，每次请求最多几轮服务端搜索 |

## 计费与额度

- Search 和 Fetch 都按 **成功请求** 计费：5 元 / 1000 次成功请求（约 0.005 元一次），自北京时间 2026-11-01 00:00 起由 DeepSeek 账号承担。搜索只在 `results` 非空时计费，抓取只在返回正文时计费；失败、超时不计费。详见官方 [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。
- 搜索与抓取**不消耗聊天模型 token**，也不占用聊天所用的订阅（如 OpenCode GO）的模型额度；只涉及 DeepSeek 账号的搜索/抓取用量。
- 每次搜索约 0.5–1 秒，每次抓取约 0.2–1 秒。
- 账号级限速按接口独立计算：Search 100 QPS、Fetch 25 QPS。
- `mode: messages` 不同：每次搜索要消耗一个完整辅助模型轮次（数千输入 token、4–6 秒），而且自同一日期起服务端工具触发的搜索同样按次计费。仅建议作为回退。

## 安全

- DeepSeek 账号 token 每次请求从 DSH 凭据服务读取（`ctx.deepseekAccount.resolveToken`），并且只发往 `api.deepseek.com`（账号服务会校验 origin）。
- 插件不把 token 写入磁盘，也不把 token 暴露给浏览器。
- 抓取由 DeepSeek 服务端完成：目标 URL 会发往 DeepSeek API，而不是在本机发起请求。仅当官方抓取因内容原因失败（403/404 或无正文）时，才会用自带的 `http` 提供方在本机再抓一次；若完全不想本地抓取，把 `fetchProvider` 设为 `http` 或设置 `fallbackFetchProvider: none`。
- 零运行时依赖、无安装脚本：纯 ESM，只用 `node:` 内建模块和全局 `fetch`。

## 要求

- DeepSeek Harness `0.2.1-rc.5` 及以上（依赖 `ctx.web` seam 与 `deepseekAccount` 服务）。
- 已在 DSH 登录 DeepSeek，且能访问 `api.deepseek.com`。
- Node.js 22+（DSH 桌面版自带运行时）。

## 验证与排错

`scripts/verify.mjs` 会完全按 harness 的方式跑一次真实搜索或抓取（使用 `~/.dsh/.credentials.yaml` 里的真实账号 token，token 不会离开进程）：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
"$NODE" scripts/verify.mjs "查询词"                       # 官方 Search API，约 0.4–0.6 秒，带 snippet
"$NODE" scripts/verify.mjs --fetch "https://example.com" # 官方 Fetch API，返回 Markdown 正文
"$NODE" scripts/verify.mjs --fetch-fallback "<url>"      # 官方 403/404 时验证本地回退
"$NODE" scripts/verify.mjs "查询词" --messages            # 旧 Messages 后端，约 4–6 秒
```

搜索/抓取失败时会返回结构化错误：`WEB_PROVIDER_CREDENTIAL_MISSING`（未登录且没有 API Key）、`WEB_PROVIDER_ERROR`（HTTP/网络问题，会附上实际使用的端点）、`WEB_INVALID_URL`（抓取 URL 在发送前就被拒绝）、`WEB_FETCH_TIMEOUT`（提供方超时）、`WEB_ABORTED`（被取消）。如果账号登录被拒，重新登录 DeepSeek 即可，不需要改端点。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-deepseek-search-account
```

会移除包及其 bundle 层，不动 profile 自身的其它配置。手工安装方式则删掉上面那两段配置。

## 许可

MIT
