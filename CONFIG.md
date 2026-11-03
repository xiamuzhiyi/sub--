# 配置说明（全部通过 Cloudflare 环境变量）

本项目的所有可配置项——站点外观、后台账号密码、订阅令牌、优选源、代理、限流与缓存——**都可以在 Cloudflare 后台用环境变量改，不需要动代码**。

代码顶部的 `USER_CONFIG` 只是「默认值」：变量设了就用变量，没设才用代码里的值。

---

## 1. 三种设置方式

### 方式 A：Cloudflare Dashboard（推荐给大多数人）

1. 进入 **Workers & Pages** → 选中你的 Worker
2. **Settings**（设置）→ **Variables and Secrets**（变量和密钥）
3. **Add** 添加变量：
   - 非敏感项（站点名、背景图、优选源等）→ 类型选 **Text / Variable**
   - 敏感项（`ADMIN_PASSWORD`、`SUB_TOKEN`、`SHORT_TOKEN`、`TGTOKEN`）→ 类型选 **Secret**，加密存储、控制台不可回显
4. 保存后**点 Deploy / 重新部署一次**（见下方「改了什么时候生效」）

### 方式 B：wrangler.toml

```toml
name = "cf-sub"
main = "worker.js"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "cf-sub"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[kv_namespaces]]
binding = "TASK_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[vars]
SUBNAME = "我的优选"
AUTHOR  = "你的名字"
IMG     = "https://example.com/bg.jpg"
MAX_IPS = "800"
```

密码类**不要**写进 `[vars]`（会进版本库），用命令：

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put ADMIN_USER
wrangler secret put SUB_TOKEN
wrangler secret put SHORT_TOKEN
```

### 方式 C：Pages 项目

Pages 的 `_worker.js` 同样支持：**Settings → Environment variables**，区分 Production / Preview 两套，正好用来做「测试环境用测试背景图、生产用正式图」。

---

## 2. 取值规则（重要）

| 规则 | 说明 |
|---|---|
| **优先级** | 环境变量 > 代码里的 `USER_CONFIG` > 内置默认 |
| **空值 = 没配** | 建了变量但留空，会**回落**到 `USER_CONFIG`，不会把页面搞成空白 |
| **显式关闭** | 想关掉某项（比如不要背景图），把值设为 `none` / `off` / `-` / `false` 之一 |
| **数值钳制** | 数值型变量超出范围或填了非数字，自动回落默认值，不会把服务打挂 |
| **大小写** | 变量名**区分大小写**，约定全大写 |
| **别名** | 同一项支持多个名字（如 `ICO` / `ICON` / `FAVICON`），取第一个非空值 |

> 举例：`IMG=none` → 纯色背景；`IMG=`（留空）→ 继续用代码里的默认背景图。

---

## 3. 变量总表

### 3.1 存储（必填）

| 变量 | 类型 | 说明 |
|---|---|---|
| `DB` | D1 绑定 | 私有优选库，**必填**。在 Settings → Bindings 里绑定，不是普通变量 |
| `TASK_KV` | KV 绑定 | 异步任务状态 + 短链。不绑则批量操作退化为同步、短链不可用 |

### 3.2 安全 / 鉴权

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 未设置 | `/admin` 与 `/api/*` 的 Basic Auth 密码。**不设 = 后台完全公开**，生产必须设 |
| `ADMIN_PASS` | — | `ADMIN_PASSWORD` 的别名 |
| `ADMIN_USER` | 未设置 | 后台用户名。**不设 = 不校验用户名**（填任意用户名都能登录，兼容旧版）；设了就必须完全一致 |
| `SUB_TOKEN` | 未设置 | 订阅令牌。设了之后 `/sub`、`/{TOKEN}` 都必须带 `?token=xxx` |
| `SHORT_TOKEN` | 未设置 | 短链生成令牌。设了之后 `/api/shorten` 需带令牌，且不再校验来源 |

> ⚠ 密码不做 `trim`，允许包含空格与冒号（如 `p@ss:1`）。
> ⚠ 设了 `ADMIN_USER` 是**严格匹配**：以前随便填用户名的习惯会失效，请确认自己填的是设定值。

### 3.3 站点外观 / 品牌

| 变量 | 默认（代码内） | 说明 |
|---|---|---|
| `SUBNAME` | `❤️红星CF优选` | 站点名：浏览器标题、页面大标题、订阅文件名 |
| `SITENAME` / `TITLE` | — | `SUBNAME` 的别名 |
| `ICO` | tux.png | 浏览器标签页图标（favicon）URL |
| `ICON` / `FAVICON` | — | `ICO` 的别名 |
| `PNG` | tux.png | 页面 Logo / 头像图片 URL |
| `AVATAR` / `LOGO` | — | `PNG` 的别名 |
| `FALLBACK` | `📡` | 没有 Logo 图片时显示的文字 / emoji |
| `AVATARFALLBACK` | — | `FALLBACK` 的别名 |
| `IMG` | 极光图 | 背景图 URL。**多个用英文逗号分隔**，每次刷新随机换一张 |
| `BACKGROUND` | — | `IMG` 的别名 |
| `BEIAN` | 空 | 页脚备案 / 版权，支持 HTML，如 `<a href="https://beian.miit.gov.cn">京ICP备xxx号</a>` |
| `BY` / `FOOTER` | — | `BEIAN` 的别名 |
| `TGCHANNEL` | `gefeiliaotian_bot` | TG 频道用户名（不带 `@`、不带 `t.me/`），用于「前往获取」链接 |
| `TG_CHANNEL` | — | `TGCHANNEL` 的别名 |
| `TGGROUP` | `gefeiliaotian_bot` | TG 群组用户名，用于页脚「加入群组」 |
| `TG_GROUP` | — | `TGGROUP` 的别名 |
| `AUTHOR` | `XiaGeFei` | 页脚「由 xxx 提供维护」 |
| `BYNAME` | — | `AUTHOR` 的别名 |

> 示例：只要 emoji 头像、不要背景图、不要署名
> ```
> PNG   = none
> IMG   = none
> AUTHOR= none
> ```
> 示例：两张背景图轮换 + 自定义 Logo
> ```
> IMG = https://cdn.example.com/a.jpg,https://cdn.example.com/b.jpg
> PNG = https://cdn.example.com/logo.png
> ```

### 3.4 订阅转换

| 变量 | 默认 | 说明 |
|---|---|---|
| `SUBAPI` | `SUBAPI.cmliussss.net` | 第三方订阅转换后端。可带协议头，`http://` 会被识别 |
| `SUBCONFIG` | ACL4SSR 在线配置 | Clash 规则配置地址 |

> 不配也能用：只输出通用 Base64。配了才能出 Clash / sing-box / Surge。
> 转换后端会看到节点信息（代码已做伪身份脱敏，但请自行评估第三方可信度）。

### 3.5 优选源

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADD` | 空 | 静态 IP 列表，`104.16.2.3:443` 多个用逗号 / 换行分隔；混进的 `http(s)` 链接会自动分拣到 API / CSV |
| `ADDAPI` | 空 | 优选 API 接口（返回 IP 列表的 URL） |
| `ADDNOTLS` | 空 | 无 TLS（80 端口）静态列表，与 `ADD` 分开 |
| `ADDNOTLSAPI` | 空 | 无 TLS 的 API 接口 |
| `ADDCSV` | 空 | CloudflareSpeedtest 产出的测速 CSV 地址 |
| `DLS` | `7` | CSV 速度阈值（MB/s），低于此值的行被丢弃 |
| `CSVREMARK` | `1` | CSV 备注列在 TLS 列之后的偏移量 |
| `MAX_IPS` | `1000` | 私有库参与订阅的最大条数，范围 **1–5000** |
| `MAX_EXT_IPS` | `1000` | 外部优选库单次最多取用条数，范围 **1–5000** |

> `MAX_IPS` 只限制「订阅读取」，不限导入。后台「订阅取用上限」卡片显示的就是这个值。
> 顺序按 `priority, id`，priority 越小越靠前，可在后台调权重。

### 3.6 代理

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXYIP` | `tw.proxyip.ggmm.kdns.fr` | ProxyIP 池，多个用逗号分隔 |
| `PROXYIPAPI` | 空 | 从接口拉取 ProxyIP 池 |
| `CMPROXYIPS` | 空 | 按地区备注匹配 ProxyIP 的映射表 |
| `SOCKS5DATA` | 空 | SOCKS5 数据源地址（`host:port#地区` 格式） |
| `RPROXYIP` | `false` | 内置节点是否注入 ProxyIP，`true` 启用 |

### 3.7 内置节点（访问 `/{TOKEN}` 即出订阅）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOKEN` | `auto` | 入口路径。设 `mytoken` 则访问 `/mytoken`；多个用逗号分隔 |
| `HOST` | `null` | 伪装域名，多个则随机取一个 |
| `UUID` | `null` | 固定 UUID |
| `PASSWORD` | 空 | 设了则改用 Trojan 协议，值即密码 |
| `KEY` | 空 | 设了则启用「按周轮换的动态 UUID」，值为种子 |
| `TIME` | `7` | 动态 UUID 有效期（天） |
| `UPTIME` | `3` | 动态 UUID 的轮换时刻（UTC+8 的小时） |
| `PATH` | `/?ed=2560` | 节点 path |
| `SNI` | 同 `HOST` | SNI |
| `TYPE` | `ws` | 传输类型 |
| `ED` | `ed` | 隧道版本标识；填 `cmliu` 启用 ProxyIP |
| `PS` | 空 | 节点名前缀备注 |
| `ALPN` | 空 | ALPN，XHTTP 模式下缺省 `h3,h2` |
| `CFPORTS` | `2053,2083,2087,2096,8443` | 可用 HTTPS 端口列表 |
| `NOTLS` | `false` | 强制无 TLS（80 端口） |
| `SCV` | `false` | 跳过证书校验（`allowInsecure`） |

> `HOST` / `UUID`（或 `KEY` / `PASSWORD`）必须至少配齐，否则订阅里会出现「未设置！！！」提示节点。

### 3.8 风控 / 伪装

| 变量 | 默认 | 说明 |
|---|---|---|
| `UA` | `telegram,twitter,miaoko` | **追加**到默认黑名单的 UA 关键词（不区分大小写），命中则返回伪装页 |
| `URL302` | 空 | 命中风控时 302 跳转的地址 |
| `URL` | 空 | 命中风控时反代的地址 |

> 首页 `/` 与 `/gen` 有意**不套用** UA 黑名单：默认名单含 `telegram`，而 TG 内置浏览器 UA 也含该词，套用会把从频道点进来的正常用户挡在外面。风控只作用于 `/sub` 与内置入口。

### 3.9 通知

| 变量 | 默认 | 说明 |
|---|---|---|
| `TGTOKEN` | 空 | Telegram Bot Token，用于访问通知 |
| `TGID` | 空 | 接收通知的 Chat ID |

### 3.10 性能 / 缓存 / 其他

| 变量 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `CACHE_TTL` | `60` | 0–86400 | `/sub` 边缘缓存秒数。**0 = 不缓存**（`Cache-Control: no-store`），调试时用 |
| `FETCH_TIMEOUT_MS` | `2000` | 300–15000 | 单个优选源拉取超时（毫秒）。源在国外慢时调大 |
| `PAGE_SIZE` | `30` | 1–100 | 后台 IP 列表每页条数 |
| `SHORT_TTL_DAYS` | `30` | 1–365 | 短链有效期（天） |
| `LINK` | 空 | — | 追加节点链接：直接写节点链接或订阅 URL，多个用逗号分隔，会合并进输出 |
| `RELAYAPI` | 空 | — | 临时中转域名接口，仅当 HOST 是 `*.workers.dev` 时按需拉取 |

> `CACHE_TTL` 改小或设为 0 后，别忘了边缘缓存本身有 60 秒左右的淘汰延迟。
> 后台任何写操作都会自增数据版本号，订阅缓存立即失效，所以改 IP 后不用等 TTL。

---

## 4. 常见场景配方

**只改品牌（最常用）**
```
SUBNAME = 我的机场
AUTHOR  = 你的名字
TGCHANNEL = your_channel
TGGROUP   = your_group
IMG     = https://cdn.example.com/bg.jpg
PNG     = https://cdn.example.com/logo.png
ICO     = https://cdn.example.com/favicon.ico
```

**极简纯色站（不要背景图）**
```
IMG = none
```

**开启后台密码 + 固定用户名 + 订阅令牌**
```
ADMIN_USER     = geoff
SUB_TOKEN      = 一串随机字符
SHORT_TOKEN    = 另一串随机字符
```
```bash
wrangler secret put ADMIN_PASSWORD
```

**私有库条目多，只想让前 200 条进订阅**
```
MAX_IPS = 200
```

**优选源换成自建测速 CSV**
```
ADDCSV = https://example.com/result.csv
DLS    = 10
```

---

## 5. 改了什么时候生效

| 操作 | 是否需重新部署 | 生效时机 |
|---|---|---|
| Dashboard 改 Text 变量 | **需要**点 Deploy | 部署完成后 |
| Dashboard 改 Secret | 不需要 | 保存后立即（新请求即读到） |
| `wrangler secret put` | 不需要 | 立即 |
| 改 `[vars]` 后 `wrangler deploy` | 需要 | 部署完成后 |

改完用浏览器**强制刷新**（Ctrl/Cmd + Shift + R）再看，CDN 与浏览器都会缓存 HTML。

---

## 6. 排查：改了没反应

1. **变量名拼错 / 大小写不对** —— 必须全大写，`Subname` ≠ `SUBNAME`。
2. **建在另一个环境** —— Pages 的 Production 与 Preview 变量是分开的。
3. **忘了重新部署** —— Text 变量改完必须 Deploy 一次。
4. **值里带了引号或空格** —— 直接填 `我的站点`，不要填 `"我的站点"`；前后空格会被裁掉，但引号会当成内容。
5. **想关闭却留空** —— 空值等于「没配」，会回落默认值；要关闭请用 `none`。
6. **以为页面立刻变** —— HTML 不缓存，但浏览器会；强制刷新。
7. **设了 `ADMIN_USER` 却登不进去** —— 用户名现在严格匹配，确认填的就是设定值；忘记设了什么就临时删掉该变量（回到「任意用户名」）。

---

## 7. 三条安全建议

1. **密码、令牌永远不要写进 `USER_CONFIG`** —— 那个文件会跟代码一起被复制、粘贴、提交，等于公开。
2. **`ADMIN_PASSWORD` 设了就别再用弱密码** —— Basic Auth 是明文传输凭据（靠 HTTPS 保护），且没有锁定机制。
3. **`SUB_TOKEN` 只发给信任的人** —— 拿到令牌就能用你的优选库与转换后端额度。
