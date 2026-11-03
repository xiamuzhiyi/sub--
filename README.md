# 优选订阅 Worker

> **版本 v1.3**（2026-11-03）：全站配置变量化——外观、后台账号密码、订阅令牌、容量与缓存参数均可用 Cloudflare 环境变量控制，无需改代码。新增 [`CONFIG.md`](CONFIG.md)。
> v1.2（2026-11-03）：修复生成器模式「没有生成任何可用节点」——该模式此前无 D1 数据源且忽略 `source`，靠私有库维护 IP 的部署必然失败。新增 D1 回退与来源自检。
> 此前 v1.1：完成全项目审查并修复 3 个 P0、5 个 P1、22 个 P2 问题。
> 发布前验证：全量回归 **175/175**、生成器模式专项 **59/59**、v1.2 修复回归 **64/64**、v1.3 配置回归 **55/55**，共 **353** 项通过（详见[验证状态](#验证状态)）。
> `worker.js` 与 `_worker.js` 内容一致，部署时任选其一。

基于 Cloudflare Workers / Pages 的**优选 IP 库管理 + 订阅生成与分发**一体化服务。

单文件部署，同时提供：

- 私有优选 IP 库（D1 持久化）+ 可视化管理后台
- 短链分发（KV）
- 多源优选拉取（静态 / API / 测速 CSV）
- 内置节点模式（免客户端参数，直接出订阅）
- 多客户端订阅转换（通用 Base64 / Clash / sing-box / Surge）
- 伪装与访问风控

---

## 目录

- [功能特性](#功能特性)
- [路由一览](#路由一览)
- [快速开始](#快速开始)
- [自定义外观](#自定义外观)
- [环境变量](#环境变量)（完整清单见 [CONFIG.md](CONFIG.md)）
- [订阅接口用法](#订阅接口用法)
- [后台管理 API](#后台管理-api)
- [验证状态](#验证状态)
- [v1.2 修复记录（2026-11-03）](#v12-修复记录2026-11-03)
- [v1.1 修复记录（2026-11-03）](#v11-修复记录2026-11-03)
- [目录结构](#目录结构)
- [设计说明](#设计说明)
- [许可与致谢](#许可与致谢)

---

## 功能特性

| 模块 | 说明 |
|---|---|
| 私有优选库 | D1 存储，支持分页、关键词搜索、启用/禁用、权重排序、按地区排序、去重、批量导入/删除、清空 |
| 管理后台 | `/admin` 可视化操作，Basic Auth 保护；批量操作走异步任务 + 前端轮询 |
| 短链分发 | 把长订阅链接压成 8 位短码，`/s/:id` 302 跳转，30 天自动过期 |
| 多源优选 | `ADD` 静态列表、`ADDAPI` 接口拉取、`ADDCSV` 测速 CSV（按 `TLS` 列 + 速度阈值过滤）；`source=multi` 时支持订阅链接内 `multi` 多行自定义（一行一个来源，自动识别 IP / API / CSV） |
| 裂变模式 | 用户提交一条基础节点链接，服务端把优选 IP 逐个套进去，生成多条节点 |
| 生成器模式 | 用户只提交 `host/uuid/path` 等参数，服务端用优选 IP 直接构建节点；优选源支持自动（环境变量 → D1 回退）/ 仅私有库 / 仅多源 / 外部优选库（页面可直接填地址） |
| 内置节点 | 访问 `/{TOKEN}`（默认 `/auto`）即出订阅，参数全部来自环境变量；支持按周轮换动态 UUID |
| 多客户端 | 按 UA 或 `format` 参数自动输出 Clash / sing-box / Surge，其余走通用 Base64 |
| 代理支持 | ProxyIP 池、按地区备注匹配 ProxyIP、SOCKS5 数据源 |
| 伪装风控 | UA 黑名单、nginx 假页、URL302 跳转、URL 反代 |
| 通知与品牌 | Telegram 访问通知、自定义图标/头像/背景/备案信息 |

---

## 路由一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | 公开 | 生成页（裂变模式） |
| GET | `/gen` | 公开 | 生成页（生成器模式） |
| GET | `/admin` | Basic Auth | 管理后台 |
| ANY | `/sub`（含 `/sub/`） | `SUB_TOKEN` | 统一订阅入口 |
| ANY | `/{TOKEN}` | `SUB_TOKEN` | 内置节点入口（默认 `/auto`） |
| ANY | `/api/*` | Basic Auth¹ | 管理 API |
| GET | `/s/:id` | 公开 | 短链 302 跳转 |

> ¹ `/api/shorten` 例外，它走自己的 `SHORT_TOKEN` 校验（未配置时仅做站内来源校验 + 频率限制）。
>
> 未匹配的路径：若配置了 `URL302` / `URL` 则返回伪装内容，否则回落到首页。
>
> 写接口（`/api/ips/batch`、`/api/ips/batch-delete`、`/api/ips/toggle-all`、`/api/ips/sort`、
> `/api/ips/remove-duplicates`）只接受 `POST`，`/api/ips/clear` 只接受 `DELETE`；
> 用 GET 调用会返回 404，避免被跨站 `<img>` 触发的 CSRF 影响（浏览器会自动带上已登录的 Basic 凭据）。

---

## 快速开始

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create sub-db
```

执行建表语句（`wrangler d1 execute sub-db --remote --file=schema.sql`，或在控制台 SQL 编辑器里执行）：

```sql
CREATE TABLE IF NOT EXISTS ips (
  id       INTEGER PRIMARY KEY,
  ip       TEXT    NOT NULL UNIQUE,   -- 形如 104.16.2.3:443，UNIQUE 是 INSERT OR IGNORE 去重的前提
  name     TEXT,                      -- 备注，如「香港优选」
  active   INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ips_active_priority ON ips(active, priority);
```

### 2. 创建 KV 命名空间（可选，但强烈建议）

```bash
npx wrangler kv namespace create TASK_KV
```

KV 用于：异步任务状态、统计缓存、短链。**不绑定 KV 时短链功能不可用**，批量操作仍可用（任务状态只存内存）。

### 3. 绑定并部署

> ⚠️ **入口文件名取决于部署方式**，这一步最容易踩坑：
>
> - **Cloudflare Workers**（`wrangler deploy`）：入口名随意，直接用 `worker.js`。
> - **Cloudflare Pages**（拖拽上传 / Git 集成）：高级模式**强制要求入口文件名为 `_worker.js`**。请把 `worker.js` 重命名为 `_worker.js` 再上传。
>
> 两种方式绑定名都要用 `DB`（D1）和 `TASK_KV`（KV）。

`wrangler.toml` 示例：

```toml
name = "sub-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "sub-db"
database_id = "<你的 database_id>"

[[kv_namespaces]]
binding = "TASK_KV"
id = "<你的 kv id>"

[vars]
ADMIN_PASSWORD = "改成你的后台密码"
SUB_TOKEN      = "改成你的订阅令牌"
```

> 敏感变量建议用 `wrangler secret put ADMIN_PASSWORD` 等方式写入，不要明文放进 `wrangler.toml`。

### 4. 初始化数据

访问 `/admin` 登录后台，用「批量导入」粘贴优选 IP，每行一条：

```
104.16.2.3:443#香港优选
104.17.3.4:443#美国优选
```

---

## 自定义外观

**全部外观配置集中在 `worker.js` 顶部的「0. ★ 用户自定义配置区 ★」（第 49 行起）**，改站点长相只需要动那一块，不用往下翻代码。

```js
const USER_CONFIG = {
	siteName: '优选订阅生成器',   // 站点名：浏览器标题 / 页面大标题 / 订阅文件名
	icon: '',                     // 站点图标(favicon) URL，留空用浏览器默认
	avatar: '',                   // 站点 Logo URL，留空显示下面的 avatarFallback
	avatarFallback: '📡',          // 未配 Logo 时显示的字符，可填 emoji
	background: '',               // 背景图 URL，多个用英文逗号分隔 → 每次刷新随机
	footer: '',                   // 页脚备案 / 版权，支持 HTML
	tgChannel: '',                // TG 频道用户名（不带 @ 和 t.me/），留空整段隐藏
	tgGroup: '',                  // TG 群组用户名，留空整段隐藏
	author: '',                   // 维护者署名，留空隐藏
};
```

### 取值优先级

```
环境变量  >  USER_CONFIG  >  内置默认值
```

**建议优先用环境变量**（见 [`CONFIG.md`](CONFIG.md)）：改代码意味着每次上游更新都要重新合并，而变量改完即生效、不进版本库。
配置区适合放「这套部署的稳定默认值」，也适合根本不想配变量的极简部署。

同一个外观项支持多个别名，例如 `ICO` / `ICON` / `FAVICON` 等价；**留空 = 没配**（回落默认），
想关掉某项请设为 `none` / `off` / `-`（例如 `IMG=none` 得到纯色背景、`PNG=none` 用 emoji 头像）。

### 生效范围

| 配置项 | 首页 `/` | 生成器页 `/gen` |
|---|---|---|
| `siteName` | ✓ 标题 + 大标题 | ✓ |
| `icon` | ✓ | ✓ |
| `avatar` / `avatarFallback` | ✓ | ✓ |
| `background` | ✓ | ✓ |
| `footer` | ✓ | ✓ |
| `tgChannel` / `tgGroup` / `author` | ✓ | — |

> 管理后台 `/admin` 是独立样式，不受配置区影响。
>
> `background` 填多个 URL 时每次刷新随机取一张；只想固定一张就只填一个。
>
> ⚠ 密码与令牌**不要**写进配置区，请用环境变量或 `wrangler secret put`（`ADMIN_PASSWORD` / `SUB_TOKEN` / `SHORT_TOKEN`）。

---

## 环境变量

> **完整清单、别名、取值规则与配置示例见 [`CONFIG.md`](CONFIG.md)**，本节只列常用项。
>
> 三条通用规则：环境变量 > 代码内 `USER_CONFIG` > 内置默认；**留空 = 没配**（回落默认）；
> 想关掉某项（如不要背景图）请设为 `none` / `off` / `-`。

### 必填

| 变量 | 说明 |
|---|---|
| `DB` | D1 数据库绑定 |

### 安全（不设则对应接口公开，生产环境务必设置）

| 变量 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | `/admin` 与 `/api/*` 的 Basic Auth 密码。**不设则后台完全公开**。允许含空格与冒号 |
| `ADMIN_PASS` | `ADMIN_PASSWORD` 的别名 |
| `ADMIN_USER` | 后台用户名。**不设则不校验用户名**（任意用户名可登录，兼容旧版）；设了则严格匹配 |
| `SUB_TOKEN` | `/sub` 与内置入口 `/{TOKEN}` 共用的订阅令牌。不设则两者都不校验 |
| `SHORT_TOKEN` | 短链生成令牌。不设则仅校验「必须指向站内 `/sub`」，并按 IP 限制 **30 次/分钟**。令牌通过 `longUrl` 内的 `short_token` 查询参数传递，例如 `{"longUrl":"/sub?base=...&short_token=xxx"}`。**开启后公开生成页将无法生成短链**（会降级显示完整链接），适合只允许管理员生成短链的场景 |

### 存储

| 变量 | 说明 |
|---|---|
| `TASK_KV` | KV 命名空间，用于任务状态 / 统计缓存 / 短链 |

### 订阅转换

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUBAPI` | `SUBAPI.cmliussss.net` | 外部订阅转换后端 |
| `SUBCONFIG` | ACL4SSR 在线配置 | 转换配置文件 |
| `SUBNAME` | 代码内 `USER_CONFIG.siteName`（当前 `❤️红星CF优选`） | 站点名 / 订阅文件名 |

### 多源优选

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADD` | — | 静态优选列表，逗号或换行分隔，支持 `ip:port#备注` |
| `ADDAPI` | — | 优选接口地址，逗号分隔；支持 `?id=备注&port=端口` 与 `proxyip=true` |
| `ADDNOTLS` | — | 无 TLS 静态列表 |
| `ADDNOTLSAPI` | — | 无 TLS 优选接口 |
| `ADDCSV` | — | 测速结果 CSV 地址；需含 `TLS` 列，末列为速度 |
| `DLS` | `7` | CSV 测速速度阈值，低于该值过滤掉 |
| `CSVREMARK` | `1` | CSV 备注列相对 `TLS` 列的偏移量 |

> `ADD` / `ADDNOTLS` 里混入的 `http(s)://` 链接会自动转移到对应的 `*API` 变量。

### 代理

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROXYIP` | `tw.proxyip.ggmm.kdns.fr` | 静态 ProxyIP 列表 |
| `PROXYIPAPI` | — | ProxyIP 接口地址（取第一个） |
| `CMPROXYIPS` | — | 按地区备注匹配的 ProxyIP，格式 `proxyip#地区` 或 `proxyip:地区` |
| `SOCKS5DATA` | — | SOCKS5 数据源地址，按地区随机选取 |
| `RPROXYIP` | `false` | 内置节点模式下是否启用 ProxyIP |

> ProxyIP 注入生效条件：`ED=cmliu`（或 URL 传 `edgetunnel=cmliu`）且请求带 `proxyip=true`。

### 内置节点模式

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TOKEN` | `auto` | 入口路径，可逗号分隔多个 |
| `HOST` | — | 伪装域名，多个则随机取一 |
| `UUID` | — | 固定 UUID（与 `KEY` 二选一） |
| `PASSWORD` | — | 设置后切换为 Trojan 协议 |
| `KEY` | — | 动态 UUID 密钥，按周期轮换 |
| `TIME` | `7` | 动态 UUID 有效期（天） |
| `UPTIME` | `3` | 动态 UUID 轮换起始小时 |
| `PATH` | `/?ed=2560` | 节点路径 |
| `SNI` | 同 `HOST` | SNI |
| `TYPE` | `ws` | 传输类型 |
| `ED` | `ed` | 隧道版本标识，`cmliu` 时启用 ProxyIP 注入 |
| `CFPORTS` | `2053,2083,2087,2096,8443` | 自定义 HTTPS 端口 |
| `NOTLS` | — | 强制启用/禁用无 TLS，**优先级高于 host 关键词判定** |
| `SCV` | `false` | 跳过证书验证 |
| `ALPN` | — | ALPN 列表 |
| `PS` | — | 节点备注后缀 |

### 风控与伪装

| 变量 | 默认值 | 说明 |
|---|---|---|
| `UA` | `telegram,twitter,miaoko` | 追加 UA 黑名单，命中则返回伪装内容 |
| `URL302` | — | 命中后 302 跳转的目标，填 `nginx` 则返回假页 |
| `URL` | — | 命中后反向代理的目标，填 `nginx` 则返回假页 |

### 通知

| 变量 | 说明 |
|---|---|
| `TGTOKEN` / `TGID` | Telegram Bot 令牌与会话 ID，用于**访问通知**推送 |

> 这两个是机器人推送，与[自定义外观](#自定义外观)里的 `tgChannel` / `tgGroup`（页面上展示的群组链接）不是一回事。

### 品牌外观

每一项都可用环境变量覆盖[自定义外观](#自定义外观)配置区，环境变量优先级更高；设为 `none` 可关闭。

| 变量（别名） | 对应配置项 | 说明 |
|---|---|---|
| `SUBNAME`（`SITENAME` / `TITLE`） | `siteName` | 站点名：标题 / 大标题 / 订阅文件名 |
| `ICO`（`ICON` / `FAVICON`） | `icon` | 站点图标 URL |
| `PNG`（`AVATAR` / `LOGO`） | `avatar` | 头像 / Logo URL |
| `FALLBACK`（`AVATARFALLBACK`） | `avatarFallback` | 无 Logo 图时显示的文字 / emoji |
| `IMG`（`BACKGROUND`） | `background` | 背景图 URL，多个逗号分隔则每次随机 |
| `BEIAN`（`BY` / `FOOTER`） | `footer` | 页脚备案信息（支持 HTML） |
| `TGCHANNEL`（`TG_CHANNEL`） | `tgChannel` | TG 频道用户名（不带 `@`），「前往获取」链接 |
| `TGGROUP`（`TG_GROUP`） | `tgGroup` | TG 群组用户名，页脚「加入群组」 |
| `AUTHOR`（`BYNAME`） | `author` | 页脚「由 xxx 提供维护」 |

### 性能与缓存

| 变量 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `CACHE_TTL` | `60` | 0–86400 | `/sub` 边缘缓存秒数；`0` = 不缓存（`no-store`） |
| `FETCH_TIMEOUT_MS` | `2000` | 300–15000 | 单个优选源拉取超时（毫秒） |
| `PAGE_SIZE` | `30` | 1–100 | 后台 IP 列表每页条数 |
| `SHORT_TTL_DAYS` | `30` | 1–365 | 短链有效期（天） |
| `MAX_IPS` | `1000` | 1–5000 | 私有库参与订阅的最大条数 |
| `MAX_EXT_IPS` | `1000` | 1–5000 | 外部优选库单次最多取用条数 |

> 数值越界或填了非数字会**自动回落默认值**，不会把服务打挂。

### 其他

| 变量 | 说明 |
|---|---|
| `LINK` | 附加订阅链接，多个逗号分隔；内容会被拉取并解析成节点合并进输出 |
| `RELAYAPI` | 临时中转域名接口（`.workers.dev` 域名下生效） |

---

## 订阅接口用法

`/sub` 是统一入口，按参数自动分流。

### 裂变模式

提交一条完整的节点链接，服务端把优选 IP 逐个套进去。

```
/sub?base=<URL编码后的节点链接>&token=<SUB_TOKEN>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `base` | 是 | 基础节点链接，支持 `vless://` / `trojan://` / `vmess://` |
| `token` | 视配置 | `SUB_TOKEN` |
| `source` | 否 | `local`（默认，读 D1）/ `ext`（外部库）/ `multi`（多源优选） |
| `ext_url` | `source=ext` 时必填 | 外部优选库地址 |
| `multi` | 否 | `source=multi` 时有效：**自定义优选多行输入**，一行一个来源，按内容自动识别类型——`.csv` 结尾（含 `.csv?xxx`）→ 测速 CSV 源；`http(s)://` 开头 → 优选 API 源；其余（如 `104.16.2.3:443`）→ 静态 ADD。生成页「自定义优选」编辑器提交的内容即此参数 |
| `add` / `addapi` / `addcsv` | 否 | 显式指定三类源（兼容旧用法），优先级高于 `multi` 的同类别结果 |
| `dls` | 否 | CSV 测速速度阈值，覆盖 `DLS` 环境变量，仅 CSV 源生效 |
| `format` | 否 | `clash` / `singbox` / `surge` |

> `source=multi` 下 URL 参数**按类别覆盖**：链接里提供了某一类源就用链接的（不再叠加环境变量），未提供的类别回退到环境变量。`add` 里混入的 `http(s)://` 链接会自动分拣：`.csv` 进 CSV 源，其余进 API 源。
>
> 示例（生成页提交后的等价链接）：
> ```
> /sub?base=<节点链接>&source=multi&multi=104.16.2.3:443,https://api.example.com/ct,https://example.com/ips.csv&dls=7
> ```

示例：

```
/sub?base=vless%3A%2F%2Fuuid%40example.com%3A443%3Ftype%3Dws&token=your_token
```

### 生成器模式

只提交参数，服务端用优选 IP 直接构建节点。

```
/sub?host=<伪装域名>&uuid=<UUID>&path=<路径>&token=<SUB_TOKEN>
```

> 示例（用外部优选库）：
> ```
> /sub?host=a.example.com&uuid=11111111-2222-4333-8444-555555555555&source=ext&ext_url=https%3A%2F%2Fexample.com%2Fbest_ips.txt
> ```

| 参数 | 说明 |
|---|---|
| `host` | 伪装域名（必填） |
| `uuid` / `password` / `pw` | 凭据（必填其一）；`password`/`pw` 触发 Trojan |
| `path` | 路径，缺省 `/?ed=2560` |
| `sni` | SNI，缺省同 `host` |
| `type` | 传输类型，缺省 `ws` |
| `alterid` | 存在即切换为 VMess |
| `security` | VMess 加密方式 |
| `alpn` | ALPN |
| `mode` / `extra` | XHTTP 相关参数 |
| `scv` / `allowInsecure` | 跳过证书验证 |
| `edgetunnel` / `epelius` | 隧道版本标识，传 `cmliu` 启用 ProxyIP |
| `proxyip` | 传 `true` 启用 ProxyIP 注入 |
| `source` | 优选来源：缺省（自动）/ `local` / `ext` / `multi`，见下表（v1.2 新增） |
| `ext_url` | `source=ext` 时必填：外部优选库地址（`http(s)://` 开头的 API 或 TXT 列表，一行一个 `IP:端口`）。**没有对应的环境变量，只能由链接传入**；`/gen` 页面选「外部公开优选库」后会展开输入框 |
| `add` / `addapi` / `addcsv` / `multi` / `dls` | 优选来源覆盖，语义与裂变模式完全一致（v1.1 起生成器模式也支持，此前会被静默忽略） |
| `format` | `clash` / `singbox` / `surge` |

**优选来源（`source`）取值：**

| 取值 | 行为 |
|---|---|
| 缺省 / 空 | **自动**：先按环境变量 `ADD` / `ADDAPI` / `ADDCSV` 收集；一条都没拿到时**回退读取 D1 私有库**中启用的 IP（最多 `MAX_IPS` 条） |
| `local` | 只读 D1 私有库（`ips` 表 `active=1`，按 `priority, id` 排序） |
| `ext` | 只读外部优选库，地址由 `ext_url` 参数给出（必填）；拉取失败时不会静默回退到 D1 |
| `multi` | 多源优选，完全不读 D1，取不到就是空 |

> **v1.2 变更**：此前生成器模式只认环境变量，**完全没有 D1 数据源**，因此凡是靠后台私有库维护 IP 的部署，`/gen` 生成的订阅必然报「没有生成任何可用节点」。现在缺省走「环境变量 → D1 回退」，
> 并在结果为空时把各来源条数写进错误节点，例如
> `❌ 没有生成任何可用节点｜来源：私有库启用 0 条｜请确认源可达、私有库有启用的 IP`
> （某类源为 0 条时不出现在 `来源` 里；未绑定 D1 则显示 `未绑定 D1`）。

> 注：`source=local` 只产出 TLS 节点——D1 里存的是 443 优选 IP，非 TLS 节点仍来自环境变量的 `ADDNOTLS` 一类源。

> `/gen` 页面的「优选 IP 来源」下拉框四个选项对应 `source` 的 `""`（自动）/ `local` / `multi` / `ext`，选中后自动拼 `&source=`。
> 选「外部公开优选库」时，下方会展开「外部优选库地址」输入框（默认隐藏），填好地址后自动拼 `&ext_url=`；
> 未填地址或地址不以 `http://` / `https://` 开头时，前端直接拦截并提示，不会生成一个注定失败的订阅链接。

### 内置节点模式

访问 `https://<你的域名>/auto` 即可，无需任何参数（`TOKEN` 可自定义入口路径）。

### 输出格式选择

优先看显式 `format` 参数，其次按客户端 UA 自动判断：

| 条件 | 输出 |
|---|---|
| `format=clash` 或 UA 含 `clash`/`meta`/`mihomo`（排除 nekobox） | Clash 配置 |
| `format=singbox` 或 UA 含 `sing-box`/`singbox` | sing-box 配置 |
| `format=surge` 或 UA 含 `surge` 且协议为 Trojan | Surge 配置 |
| UA 含 `cf-workers-sub`（转换后端回捞标识） | 通用 Base64（防回捞死循环） |
| 其余 | 通用 Base64 |

> 订阅转换会经由 `SUBAPI` 指定的第三方后端，过程中会对 `uuid`/`host` 做脱敏替换，转换完成后再还原。

---

## 后台管理 API

全部需要 Basic Auth（`/api/shorten` 除外）。异步接口返回 `taskId`，用 `GET /api/task/:id` 轮询。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ips` | 分页查询，支持 `page` / `limit` / `keyword` / `needTotal` |
| POST | `/api/ips` | 新增单条，body `{ ip, priority? }` |
| PUT | `/api/ips/:id` | 更新，body `{ ip?, active?, priority? }` |
| DELETE | `/api/ips/:id` | 删除单条 |
| GET | `/api/ips/stats` | 总数 / 活跃数 / 禁用数 |
| POST | `/api/ips/batch` | 批量导入，body `{ ips: string[] }` |
| POST | `/api/ips/batch-delete` | 批量删除，支持裸 IP 或完整节点链接 |
| DELETE | `/api/ips/clear` | 清空全部 |
| POST | `/api/ips/toggle-all` | 全量启用/禁用，body `{ active }` |
| POST | `/api/ips/sort` | 按地区 + 权重重排 ID |
| POST | `/api/ips/remove-duplicates` | 按 IP（忽略端口）去重 |
| GET | `/api/task/:id` | 查询异步任务状态 |
| POST | `/api/shorten` | 生成短链，body `{ longUrl }` |

---

## 验证状态

v1.1 / v1.2 发布前用 mock 的 Cloudflare 运行环境（D1 / KV / caches / fetch）驱动**真实 worker 代码**做过完整验证，无需联网、无需部署。
（测试脚本属开发期资产，未包含在交付目录中。）

### 全量回归 — 175 项全绿

| 分区 | 条数 | 覆盖范围 |
|---|---|---|
| A 页面输入项与前端逻辑 | 37 | 生成页全部输入项、多源多行编辑器（行号/条纹对齐）、品牌配置 |
| B 路由鉴权 | 12 | Basic Auth、`/api/shorten` 令牌、短链鉴权边界 |
| C 裂变模式 | 31 | local/ext/multi/dls 全来源、Token+UA+格式组合、缓存键变体 |
| D 生成器模式 | 8 | host/uuid/password 入参、URL 级多源参数、缺参提示 |
| E 内置节点 | 5 | `/{TOKEN}` 入口、动态 UUID |
| F 管理 API | 16 | 13 个端点的增删改查、批量、任务轮询、短链全链路 |
| G 订阅输出格式 | 24 | clash/singbox/surge 三路转换、format 归一、5xx、回捞防死循环、UA 识别 |
| H 页面渲染完整性 | 10 | 三个页面内联脚本浏览器解析级验证、静态 HTML 无插值残留 |
| I v1.1 缺陷修复回归 | 34 | 裂变脱敏、CSRF、IPv6 去重、内置入口 Token、CSV 备注、流量头、地区识别、缓存版本化等 |

### 生成器模式专项 — 59 项全绿

| 分组 | 条数 | 覆盖范围 |
|---|---|---|
| 1 VLESS 基础构造 | 13 | 默认/自定义 path·sni·type·端口、path 补斜杠、ALPN 单次编码、allowInsecure、XHTTP、IPv6 |
| 2 协议切换 | 7 | `alterid` → VMess 全字段、`password`/`pw` → Trojan、强制 TLS |
| 3 ProxyIP / SOCKS5 | 5 | `edgetunnel=cmliu`+`proxyip=true`、CMPROXYIPS 回退、SOCKS5 路径与地区后缀剥离 |
| 4 NOTLS | 4 | TLS 与无 TLS 节点并存、80 端口、`security=` 空值、未开启时只有 TLS |
| 5 多源优选 | 8 | env ADD/ADDAPI/ADDCSV 合并、CSV TLS 列过滤与备注、URL add 覆盖、multi 自动分类、DLS 阈值 |
| 6 输出格式与脱敏 | 13 | clash/singbox/surge、脱敏（不含真实 uuid/host）、伪身份还原闭环、UA 识别、`Subscription-Userinfo` 等响应头 |
| 7 鉴权 / 缺参 / 附加 / 缓存 | 9 | 202 缺参页、SUB_TOKEN、`LINK` 合并、边缘缓存命中与缓存键隔离、`/sub/`、临时中转域名 |

---

### v1.2 生成器模式回归 — 64 项全绿

| 分组 | 条数 | 覆盖范围 |
|---|---|---|
| 1 原故障场景 | 5 | 仅 D1 有启用 IP、无 `ADD/ADDAPI/ADDCSV`、无 `source` 参数 → 必须产出真实节点；备注 `ip#名称` 保留 |
| 2 `source` 语义 | 7 | 自动回退 D1、`local` 只读 D1、`multi` 不读 D1、URL `add` 优先级、`ext` 走外部库 |
| 3 失败自检 | 4 | 全来源为空时的错误节点文案含各来源条数；未绑定 D1 显式提示 |
| 4 非回归 | 4 | NOTLS / 裂变模式 / 输出格式 / 脱敏未受影响 |
| 5 外部库与页面联动 | 13 | `ext` 正常拉取（注释行/空行/去重）、缺 `ext_url` 与 404 的诊断文案、`/gen` 新增控件与内联脚本可解析、`ext` 与 D1 共存时互不回退 |
| 6 私有库回退专项 | 31 | 纯 D1 出节点与 SQL 条件（`active=1` / `priority,id` / `LIMIT`）、env 优先即短路不查库、D1 空/未绑定/查询抛错三种降级、`local` 与 `multi` 语义、裂变模式默认 D1 未受影响 |

---

## v1.3 变更记录（2026-11-03）—— 配置全变量化

**目标**：外观、账号密码、令牌、容量与缓存参数全部可脱离代码修改，配套文档 [`CONFIG.md`](CONFIG.md)。

| 类别 | 变更 |
|---|---|
| 新增环境变量 | `ADMIN_USER`、`ADMIN_PASS`、`FALLBACK`、`TGCHANNEL`、`TGGROUP`、`AUTHOR`、`CACHE_TTL`、`FETCH_TIMEOUT_MS`、`PAGE_SIZE`、`SHORT_TTL_DAYS`、`MAX_EXT_IPS` |
| 别名支持 | `SITENAME`/`TITLE`、`ICON`/`FAVICON`、`AVATAR`/`LOGO`、`BACKGROUND`、`FOOTER`、`AVATARFALLBACK`、`TG_CHANNEL`/`TG_GROUP`、`BYNAME` |
| 新增「关闭」语法 | 变量设为 `none` / `off` / `-` / `false` 可显式关掉该项（空值仍表示「没配」并回落默认）。解决「代码里设了默认头像/背景，就没法改成 emoji 头像或纯色背景」的问题 |
| 数值校验 | 数值型变量统一走 `numEnv()`：越界钳制、非数字回落默认，填错不会把服务打成空订阅 |
| 外观读取重构 | `USER_CONFIG` 的所有项都改为「环境变量 > `USER_CONFIG` > 内置默认」，`pickEnv()` 保证空字符串不覆盖默认值 |
| 后台用户名 | `checkAuth()` 支持 `ADMIN_USER`；**默认不校验用户名**以兼容旧版，显式配置后严格匹配 |

> 兼容性：不配置任何新变量时，行为与 v1.2 完全一致（`ADMIN_USER` 未设 → 任意用户名可登录）。

### v1.3 配置回归 — 55 项全绿

| 分组 | 条数 | 覆盖范围 |
|---|---|---|
| 1 默认外观 | 6 | 不设变量时站点名 / favicon / 背景 / 署名 / TG 链接来自 `USER_CONFIG` |
| 2 变量覆盖 | 11 | `SUBNAME`/`ICO`/`PNG`/`IMG`/`BEIAN`/`TGCHANNEL`/`TGGROUP`/`AUTHOR` 均生效，`/gen` 同步 |
| 3 别名 | 8 | 八组别名变量逐一验证 |
| 4 空值语义 | 4 | 空字符串回落 `USER_CONFIG`，不清空页面 |
| 5 鉴权 | 9 | 公开 / 401 / 正确密码 / 密码含冒号 / `ADMIN_USER` 严格匹配 / API 同样受限 / `ADMIN_PASS` 别名 |
| 6 数值参数 | 9 | `MAX_IPS` 生效与钳制、`PAGE_SIZE`、`CACHE_TTL`（含 0 → `no-store`） |
| 7 页面完整性 | 2 | `/` 与 `/gen` 内联脚本可解析 |
| 8 显式关闭 | 6 | `PNG=none` 出 emoji 头像、`IMG=off` 无背景、`ICO=-` 无 favicon、`AUTHOR=none` 无署名等 |

---

## v1.2 修复记录（2026-11-03）

**现象**：生成器模式粘贴节点链接后，生成的订阅刷不出内容，报 `❌ 没有生成任何可用节点(请检查优选源与节点参数)`。

**根因**：生成器模式的取址链路 `buildGeneratorLinks → collectAddresses` 只读环境变量 `ADD` / `ADDAPI` / `ADDCSV`，**完全没有 D1 数据源**，并且对 URL 的 `source` 参数视而不见。凡是靠后台私有库维护 IP（`/admin` 里录入、启用）的部署，生成器模式取址恒为空 → 必然报错。裂变模式走的是 `local`（D1）分支，所以同一份数据在裂变模式下正常，只有生成器模式坏——这也是此前测试没抓到的原因：生成器专项用例都显式给了 `env.ADD`，从未覆盖「只有 D1」这条路径。

**修复**：

1. 新增 `loadD1Addresses()`：从 `ips` 表读 `active=1`，按 `priority, id` 排序，上限 `MAX_IPS`，备注拼成 `ip#名称`。
2. 新增 `collectGeneratorAddresses()` 承接生成器取址，语义：
   - 缺省（自动）→ 先走多源收集，结果为空才回退 D1；
   - `source=local` → 只读 D1；`source=ext` → 只读外部库；`source=multi` → 不读 D1。
3. 新增 `describeGeneratorSources()`：失败时把各来源条数、私有库启用条数与 D1 绑定状态拼进错误节点，便于自查；显式单一来源时只报该来源（不再列出未参与取址的源）。
4. `/gen` 页面新增「优选 IP 来源」下拉框（自动 / 仅私有库 / 仅环境变量多源 / 外部公开优选库），选中后自动拼 `&source=`；同时修掉 `select` 未纳入样式导致的深色文字问题。
5. `/gen` 页面新增「外部优选库地址」输入框（随 `source=ext` 显隐）：填好后自动拼 `&ext_url=`，前端校验非空与 `http(s)://` 前缀，避免生成注定失败的链接。服务端也把 `ext` 拉取失败（缺参 / 非 2xx / 返回网页）从「订阅生成失败」改为写进来源诊断，例如 `❌ 没有生成任何可用节点｜来源：外部库拉取失败：HTTP状态码异常: 404｜…`。

---

## v1.1 修复记录（2026-11-03）

审查报告见 `REVIEW-2026-11-03.md`，此处只列修复结果。

**P0（安全 / 数据丢失）**

1. 裂变模式对第三方转换后端**脱敏完全失效**：`rt.uuid/rt.host` 只在生成器模式解析，`applyFake` 前置条件恒为假，真实凭据明文发给 `SUBAPI`。→ 裂变分支新增 `extractBaseCredentials()` 解析 base，脱敏改为按字段独立生效，并覆盖 URL 编码变体。
2. `removeDuplicates` 对 IPv6 **误删**：`GROUP BY SUBSTR(ip,1,INSTR(ip,':')-1)` 使所有 `[::1]:443` 分组键都是 `"["`。→ 改为应用层按「IP 忽略端口」去重（`ipDedupKey`）。
3. 写接口接受 GET + Basic Auth 自动携带 = **CSRF**（`GET /api/ips/toggle-all` 会禁用全库）。→ 所有写接口强制方法校验，`toggle-all` 另加参数类型校验。

**P1（功能缺陷）**

4. 内置入口 `/{TOKEN}` 不校验 `SUB_TOKEN`（与文档矛盾）→ 与 `/sub` 共用 `subTokenGuard`。**升级提示**：已开启 `SUB_TOKEN` 的部署，内置入口需带 `?token=xxx`。
5. 生成器模式静默忽略 URL 的 `add/addapi/addcsv/multi/dls` → 抽出 `applyUrlSourceOverrides()`，两条路径共用。
6. `rt.total/ud/expire` 是死代码 → 真正输出 `Subscription-Userinfo` 响应头。
7. 后台 `poll()` 遇 404 永不 `clearInterval`（每秒永久轮询）→ 增加错误分支与 60 次硬超时。
8. 地区识别子串误判（`Network`→TW、`RUSSIA`→US）且中英名被当作不同地区 → 改别名表 + ASCII 词边界匹配，统一归一为地区码。

**P2（健壮性 / 交互）**

9. `/sub/` 尾斜杠回落首页 → 路由归一。
10. CSV 缺「数据中心」列时把速度当备注 → 备注列必须严格位于 TLS 列与末列之间。
11. VMess 且 `noTLS=false` 仍抓一次无 TLS 源 → 仅在真正需要时抓取。
12. 首页移动端溢出（`.card{margin-left:240px}` 无媒体查询）→ 补 900px / 420px 断点。
13. 首页大标题硬编码 → 改用 `siteName`。
14. `UA` 黑名单大小写敏感 → 统一小写。
15. 批量导入提示按提交条数报数 → 汇总 `INSERT OR IGNORE` 真实 `changes`，区分新增与跳过。
16. `MAX_IPS` 只限读不限写且无提示 → `/api/ips/stats` 返回 `limit`，后台新增「订阅取用上限」卡片，超限变红。
17. 多源共享一个 2s `AbortController`（一慢全废）→ 每源独立超时。
18. `source=ext` 无条数上限/去重 → 去重 + 最多 1000 条。
19. `/api/shorten` 无限频 → 每 IP 30 次/分钟。
20. `applyFake` 会把全文 `"null"` 替换（内置模式未配 HOST/UUID 时）→ 非 4 字符以上或等于 `'null'` 的值不参与替换。
21. Surge 直传用 `|` 分帧，备注含 `|` 会拆坏 → 先转全角 `｜`。
22. Telegram 通知字段未转义（`parse_mode=HTML` 会 400）→ 统一 HTML 转义。
23. 两阶段改 ID 中途失败留负 ID → 失败时尽力回滚并抛出。
24. 后台 `load()` 无错误处理（401/500 停在"加载中"）→ 增加失败分支与原因展示。
25. 短链前缀可被 `/sub/../evil` 绕过 → 先 URL 规范化再校验，只存规范化路径。
26. 首页 `extUrl` 预填示例域名 → 改为空值 + 占位符。
27. 两页 QR 库不一致且 CDN 失败会被报成"网络请求失败" → 统一 `@keeex/qrcodejs-kx`，二维码独立渲染并静默降级。
28. 后台写入后订阅最长 60s 陈旧 → 缓存键并入数据版本号（KV `cache:dv`），写入即失效。
29. VMess URL-safe base64 / 缺 padding 直接 `atob` 抛错 → 统一 `normalizeBase64()`（服务端与生成器页均处理）。
30. SOCKS5 数据源 `host:port#地区` 的 `#地区` 后缀被拼进节点 path → 选择后剥离后缀。

> 说明：首页与 `/gen` 有意**不套用** UA 黑名单 —— 默认名单含 `telegram`，
> 而 TG 内置浏览器 UA 同样含该词，套用会让从频道点进来的正常用户看到伪装页。
> 伪装风控只作用于 `/sub` 与内置入口。

---

## 目录结构

```
.
├── worker.js                  # 主程序，CF Workers 部署入口（单文件）
├── _worker.js                 # 与 worker.js 内容一致，Pages 部署入口名
├── _worker.zip                # _worker.js 的打包产物，供 Pages 拖拽上传
├── schema.sql                 # D1 建表脚本
├── CONFIG.md                  # 环境变量完整清单与配置示例
├── REVIEW-2026-11-03.md       # 全项目审查报告（修复前快照）
└── README.md                  # 本文档
```

> 部署到 Pages 时，把 `worker.js` 重命名为 `_worker.js`（见[快速开始](#3-绑定并部署)），或直接上传 `_worker.zip`。
>
> `_worker.zip` 与 `_worker.js` 必须同源同版本；改完 `worker.js` 请一并同步 `_worker.js` 并重新打包。

---

## 设计说明

### 请求级运行时（`rt`）

所有请求相关状态收敛在 `buildRuntime()` 返回的 `rt` 对象里，不使用模块级可变变量。

这是本项目与上游 `_worker.js` 的关键差异：上游把 `host`、`uuid`、`path`、`sni`、协议类型等放在模块级 `let` 上，而 Cloudflare Workers 的 isolate 会跨请求复用，并发时这些值会互相覆盖，导致节点串味、`path` 错乱。

出网拉取（`PROXYIPAPI` / `SOCKS5DATA`）与伪身份哈希都做了惰性化，只在真正生成订阅时才执行——首页和后台 API 不会产生无谓的网络请求。

### `/sub` 统一分流

`base` 存在 → 裂变模式；否则 → 生成器模式。两条路径共用同一套输出层（格式转换、脱敏、响应头）。

### 边缘缓存

`/sub` 的响应按「URL + 输出变体 + 数据版本号」缓存 60 秒。缓存键包含输出格式，避免把 Clash 配置发给请求 Base64 的客户端；包含数据版本号（KV `cache:dv`，后台每次写入自增），使后台改动**立即**反映到订阅，不必等 TTL 过期。

### 数据源优先级

裂变模式下 `source` 依次可选：`local`（D1，默认）→ `multi`（多源优选，URL 参数优先、环境变量兜底）→ `ext`（外部库）。

生成器模式下 `source` 语义为：缺省时**环境变量优先、为空则回退 D1**；显式 `local` / `ext` / `multi` 则只走该单一来源。两条路径都接受 `add` / `addapi` / `addcsv` / `multi` / `dls` 覆盖环境变量。

### 脱敏

走外部订阅转换后端（`SUBAPI`）时，会对 `uuid` 与 `host` 做伪身份替换，转换完成后再还原：

- 生成器模式从查询参数取 `uuid`/`host`；
- 裂变模式从 `base` 的基础节点链接解析（VLESS/Trojan 用 `URL`，VMess 解 base64）。

两个字段**各自独立**脱敏，任一字段缺失不影响另一个；`'null'` 等占位值不参与替换。
---

## 许可与致谢

本项目由两份代码合并而成：

- `worker.js`（原）：私有优选库 + 管理后台 + 短链
- `_worker.js`（原）：基于开源项目 [cmliu/WorkerVless2sub](https://github.com/cmliu/WorkerVless2sub) 的二次修改，遵循其 MIT License

合并后的代码保留了上游的多源优选、内置节点、订阅转换与伪装风控逻辑，并按上述设计做了状态隔离与缺陷修复。

使用前请确认符合你所在地区的法律法规与 Cloudflare 服务条款。
