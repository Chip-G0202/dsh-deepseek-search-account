# dsh-deepseek-search-account

[English](README.md) | 中文

一个很小的 DeepSeek Harness（DSH）插件：**当你的聊天模型接的是外部非官方订阅/网关（例如 OpenCode Go、其他 Anthropic 兼容网关、pi-ai 等），只要 DSH 里已登录 DeepSeek 账号，内置 `web_search` 就仍然可用——搜索走 DeepSeek 官方 Search API、使用该账号的官方额度，不需要 `DEEPSEEK_API_KEY`。**

## 适用情况

**推荐在这些条件下使用：**

- DSH 的聊天模型由第三方订阅/网关提供（OpenCode Go / Zen、其他 Anthropic 兼容端点、pi-ai 等），不是 DeepSeek 账号模型；
- 你已在 DSH 里登录 DeepSeek 账号（设置 → 账号），并且愿意让该账号承担搜索调用；
- 内置网页搜索报错 `DeepSeek search has no API key for "DEEPSEEK_API_KEY"`，而你手上没有、或不想用 DeepSeek API Key。

这时 `web_fetch` 正常、只有 `web_search` 不可用。装上本插件后，**搜索仍然走 DeepSeek 官方额度和 Search API**，聊天所用的订阅（如 OpenCode GO）完全不受影响、也不会被搜索消耗。

**不需要安装的情况：**

- 聊天模型本身就是 DeepSeek 账号模型——官方提供方已经会用账号登录搜索；
- 你已经配置了 `DEEPSEEK_API_KEY`——官方提供方本来就可用（也可以在「插件 → 内置插件配置 → 网页搜索」里启用新版 Search API）；
- 你已经在用其他搜索提供方插件（Exa、Tavily、SearXNG、智谱等）并已满足需求。

## 为什么需要它

DSH 自带的搜索提供方（`dsh-web-search-deepseek`、`dsh-web-deepseek-api`）**只在「发起搜索的会话」模型路由为 `deepseek-account` 时**才使用 DeepSeek 账号登录：

```js
ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider === "deepseek-account"
```

聊天走 OpenCode Go 时这个判断不成立，提供方转而解析 `DEEPSEEK_API_KEY`；没有 key 就报错。本插件在**每次搜索**时直接取 `ctx.deepseekAccount.resolveToken(endpoint)`，不看聊天模型路由；只有账号登录不可用时才回退到 `DEEPSEEK_API_KEY`（Bearer）。

## 它做什么

- 在 `ctx.web` seam 上注册搜索提供方 `deepseek-account-search`；
- 默认走 **DeepSeek 官方 Search API**（`POST https://api.deepseek.com/v1/tools/search`）：一次请求约 0.5–1 秒，返回 `title` / `url` / `snippet` / `date`，不产生辅助模型轮次、不消耗模型 token；
- 保留旧的 `mode: messages` 后端（Anthropic 兼容 Messages + 原生 `web_search_20250305` 服务端工具）作为显式回退；
- 自带 bundle 补丁 `cordis.patch.yml`：注册提供方并把 `web.searchProvider` 固定为它，同时保持 `web.fetchProvider: http`。

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
    fetchProvider: http
```

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
| `mode` | `search-api` | `search-api` = 官方 Search API；`messages` = Anthropic Messages + `web_search_20250305` 服务端工具 |
| `baseURL` | `https://api.deepseek.com/v1/tools` | Search API 基址（追加 `/search`） |
| `count` | `10` | 每次 Search API 请求的条数，1–50；工具侧 `searchMaxResults` 更小时以更小者为准 |
| `sendOriginalQuestion` | `true` | 是否发送 `ori_question`（会话最近一条用户提问，≤128 字符） |
| `apiKey` / `apiKeyEnv` | 未设置 / `DEEPSEEK_API_KEY` | 账号登录不可用时的 API Key 回退 |
| `messagesBaseURL` | `https://api.deepseek.com/anthropic/v1` | 仅 `mode: messages`（追加 `/messages`） |
| `model` | `deepseek-flash` | 仅 `mode: messages` |
| `apiVersion` | `2023-06-01` | 仅 `mode: messages`（官方文档说明该头会被忽略） |
| `maxTokens` | `4096` | 仅 `mode: messages` |
| `maxUses` | `5` | 仅 `mode: messages`，每次请求最多几轮服务端搜索 |

## 计费与额度

- 默认的 `search-api` 后端按 **成功请求** 计费：5 元 / 1000 次成功请求（约 0.005 元一次），自北京时间 2026-11-01 00:00 起由 DeepSeek 账号承担；失败、空结果、超时不计费。详见官方 [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。
- 搜索**不消耗聊天模型 token**，也不占用聊天所用的订阅（如 OpenCode GO）的模型额度；只涉及 DeepSeek 账号的搜索用量。
- 每次搜索约 0.5–1 秒。
- `mode: messages` 不同：每次搜索要消耗一个完整辅助模型轮次（数千输入 token、4–6 秒），而且自同一日期起服务端工具触发的搜索同样按次计费。仅建议作为回退。

## 安全

- DeepSeek 账号 token 每次搜索从 DSH 凭据服务读取（`ctx.deepseekAccount.resolveToken`），并且只发往 `api.deepseek.com`（账号服务会校验 origin）。
- 插件不把 token 写入磁盘，也不把 token 暴露给浏览器。
- 零运行时依赖、无安装脚本：纯 ESM，只用 `node:` 内建模块和全局 `fetch`。

## 要求

- DeepSeek Harness `0.2.1-rc.5` 及以上（依赖 `ctx.web` seam 与 `deepseekAccount` 服务）。
- 已在 DSH 登录 DeepSeek，且能访问 `api.deepseek.com`。
- Node.js 22+（DSH 桌面版自带运行时）。

## 验证与排错

`verify.mjs` 会完全按 harness 的方式跑一次真实搜索（使用 `~/.dsh/.credentials.yaml` 里的真实账号 token，token 不会离开进程）：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
"$NODE" verify.mjs "查询词"              # 官方 Search API，约 0.4–0.6 秒，带 snippet
"$NODE" verify.mjs "查询词" --messages   # 旧 Messages 后端，约 4–6 秒
```

搜索失败时会返回结构化错误：`WEB_PROVIDER_CREDENTIAL_MISSING`（未登录且没有 API Key）、`WEB_PROVIDER_ERROR`（HTTP/网络问题，会附上实际使用的端点）、`WEB_ABORTED`（被取消）。如果账号登录被拒，重新登录 DeepSeek 即可，不需要改端点。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-deepseek-search-account
```

会移除包及其 bundle 层，不动 profile 自身的其它配置。手工安装方式则删掉上面那两段配置。

## 许可

MIT
