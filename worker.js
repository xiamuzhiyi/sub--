/**
 * ============================================================================
 *  优选订阅 · 合并版 Worker
 * ----------------------------------------------------------------------------
 *  私有优选 IP 库(D1) + 管理后台 + 短链分发  *  融合   :多源优选拉取 + 内置节点 + 多客户端订阅转换 + 伪装风控

 *  环境变量
 *   [必填] DB            D1 数据库（私有优选库）
 *   [可选] TASK_KV       KV 命名空间（异步任务状态 / 短链）
 *   [可选] ADMIN_PASSWORD / ADMIN_USER  后台与 /api 的 Basic Auth（密码不设则后台公开；
 *                                       ADMIN_USER 不设则不校验用户名）
 *   [可选] SUB_TOKEN     订阅接口令牌（不设则不校验）
 *   [可选] SHORT_TOKEN   短链生成接口令牌（不设则仅做站内来源校验）
 *   [可选] SUBAPI / SUBCONFIG / SUBNAME   订阅转换后端 / 配置 / 站点名
 *   [可选] ADD / ADDAPI / ADDNOTLS / ADDNOTLSAPI / ADDCSV / DLS / CSVREMARK  多源优选
 *   [可选] PROXYIP / PROXYIPAPI / CMPROXYIPS / SOCKS5DATA / RPROXYIP
 *   [可选] TOKEN / HOST / UUID / PASSWORD / KEY / TIME / UPTIME / PATH / SNI / TYPE / ED
 *   [可选] UA / URL302 / URL / NOTLS / SCV / ALPN / CFPORTS / PS
 *   [可选] TGTOKEN / TGID      Telegram 访问通知
 *   [可选] ICO / PNG / IMG / BEIAN / BY / LINK / RELAYAPI
 *   [可选] 外观别名：ICON / FAVICON / AVATAR / LOGO / BACKGROUND / FOOTER /
 *                    FALLBACK / TGCHANNEL / TGGROUP / AUTHOR / SITENAME
 *
 *  自定义外观
 *   文件顶部的「0. ★ 用户自定义配置区 ★」集中了站点名、图标、头像、背景图、
 *   页脚、联系方式等全部外观项，可作为默认值；每一项都能用同名环境变量覆盖。
 *   完整变量清单与配置示例见 CONFIG.md。
 * ============================================================================
 */

// ============================================================================
// 0. ★ 用户自定义配置区 ★
// ----------------------------------------------------------------------------
//  【改外观只改这里】站点名 / 图标 / 头像 / 背景图 / 页脚 / 联系方式全在这一块。
//
//  取值优先级：  环境变量  >  本配置区  >  内置默认值
//  这里填了值就生效；若在 Cloudflare 后台同时配了同名环境变量
//  （SUBNAME / ICO / PNG / IMG / BEIAN / FALLBACK / TGCHANNEL / TGGROUP / AUTHOR），
//  则环境变量优先，方便同一份代码在多套环境（测试 / 生产）之间切换。
//
//  ⚠ 本文件里的值会被打进代码、随代码仓库公开。密码、令牌等敏感信息
//    请务必用环境变量 / `wrangler secret put` 设置：
//    ADMIN_PASSWORD / ADMIN_USER / SUB_TOKEN / SHORT_TOKEN。
// ============================================================================
const USER_CONFIG = {
	/* -------------------- 站点标识 -------------------- */

	// 站点名：浏览器标题、页面大标题、订阅文件名都用它
	siteName: '❤️红星CF优选',

	// 站点图标（favicon）URL。留空 = 浏览器默认图标
	// 例：'https://example.com/favicon.ico'
	icon: 'https://raw.githubusercontent.com/xiagefei/CFBestIP/refs/heads/main/tux.png',

	// 站点 Logo / 头像 URL。留空 = 显示下方的 avatarFallback 字符
	// 例：'https://example.com/logo.png'
	avatar: 'https://raw.githubusercontent.com/xiagefei/CFBestIP/refs/heads/main/tux.png',

	// 未设置 avatar 时显示的字符，可填 emoji
	avatarFallback: '📡',

	// 页面背景图 URL。留空 = 纯色背景
	// 填多个（英文逗号分隔）→ 每次刷新随机换一张
	// 例：'https://a.com/1.jpg,https://a.com/2.jpg'
	background: 'https://raw.githubusercontent.com/xiagefei/CFBestIP/refs/heads/main/bioluminescence-3840x2160-15292.jpg',

	// 页脚备案 / 版权信息，支持 HTML。留空 = 不显示
	// 例：'<a href="https://beian.miit.gov.cn">京ICP备00000000号</a>'
	footer: '',

	/* -------------------- 联系方式（留空即整段隐藏） -------------------- */
	// 以下三项同样支持环境变量覆盖：TGCHANNEL / TGGROUP / AUTHOR

	// Telegram 频道用户名。不带 @、不带 t.me/ 前缀，例：'my_channel'
	tgChannel: 'gefeiliaotian_bot',

	// Telegram 群组用户名，例：'my_group'
	tgGroup: 'gefeiliaotian_bot',

	// 维护者署名，例：'某某某'
	author: 'XiaGeFei',
};

// ============================================================================
// 1. 常量
// ============================================================================
const PAGE_SIZE = 30;
const BATCH_SIZE = 50;
const MAX_IPS = 1000;
const CACHE_TTL = 60;
const STATS_CACHE_KEY = 'cache:stats';
const DATA_VERSION_KEY = 'cache:dv'; // 数据版本号：后台写入后自增，用于让 /sub 边缘缓存键失效
const TASK_TTL = 300;
const SHORT_TTL = 30 * 24 * 3600; // 短链有效期 30 天（修复：原实现 kv.put 未设 TTL，永不过期）
const SHORT_MAX_URL = 4096;       // 短链原始 URL 长度上限（修复：原实现无长度限制）
const SHORT_PREFIX = '/sub';      // 短链只允许指向站内 /sub（修复：原实现可被当免费短链/开放重定向滥用）
const SHORT_RATE_LIMIT = 30;      // 短链生成频率限制（每 IP 每分钟，修复：原实现无任何频率限制）

const FETCH_TIMEOUT_MS = 2000;    // 单个优选源超时（修复：原实现多个源共用一个 AbortController，一慢全废）
const MAX_EXT_IPS = 1000;         // 外部优选库单次最多取用条数
const DB_PAGE_SIZE = 500;         // 全表遍历分页大小（D1 单次返回行数有上限）

// 地区别名：同一地区的英文码与中文名必须映射到同一个序号，
// 否则「按地区排序」会把 HK 与 香港 拆成两段（等宽）。
// ASCII 码用词边界匹配，避免 Network→TW、RUSSIA→US、Australia→US 这类子串误判。
const REGION_ALIASES = [
	['HK', ['HK', 'HONGKONG', 'HONG KONG', '香港']],
	['TW', ['TW', 'TAIWAN', '台湾', '台灣']],
	['JP', ['JP', 'JAPAN', '日本']],
	['SG', ['SG', 'SINGAPORE', '新加坡']],
	['KR', ['KR', 'KOREA', '韩国', '韓國']],
	['US', ['US', 'USA', 'UNITED STATES', '美国', '美國']],
];
const REGION_ORDER = new Map();
const REGION_PATTERNS = [];
REGION_ALIASES.forEach(([code, aliases], index) => {
	aliases.forEach(alias => {
		REGION_ORDER.set(alias, index);
		REGION_PATTERNS.push({
			code,
			alias,
			re: /^[A-Z0-9 ]+$/.test(alias) ? new RegExp(`\\b${alias}\\b`, 'i') : null,
		});
	});
});
const UNKNOWN_REGION_INDEX = REGION_ALIASES.length;

const IP_FORMAT_REGEX = /^(\[[a-fA-F0-9:]+\]|[^:#\[\]]+)(?::(\d+))?(#.*)?$/;

const NODE_IP_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[.*\]):?(\d+)?#?(.*)?$/;
const DEFAULT_HTTPS_PORTS = ['2053', '2083', '2087', '2096', '8443'];
const HTTP_PORTS = ['8080', '8880', '2052', '2082', '2086', '2095'];

const DEFAULT_SUB_CONVERTER = 'SUBAPI.cmliussss.net';
const DEFAULT_SUB_CONFIG = 'https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_Full_MultiMode.ini';
const DEFAULT_SUB_NAME = '优选订阅生成器';
const DEFAULT_PROXYIP = 'tw.proxyip.ggmm.kdns.fr';
const DEFAULT_BLOCK_UA = ['telegram', 'twitter', 'miaoko'];
const DEFAULT_ENTRY_TOKENS = ['auto'];

// ============================================================================
// 2. 通用工具
// ============================================================================
const json = (d, s = 200) => Response.json(d, { status: s });
const err = (m, s = 400) => Response.json({ error: m }, { status: s });
const htmlResponse = (body) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const textResponse = (body, status = 200, headers = {}) =>
	new Response(body, { status, headers: { 'Content-Type': 'text/plain;charset=utf-8', ...headers } });

const utf8ToBase64 = (str) => btoa(unescape(encodeURIComponent(str)));
const base64ToUtf8 = (str) => new TextDecoder().decode(Uint8Array.from(atob(str).split('').map(c => c.charCodeAt(0))));
const encodeBase64 = utf8ToBase64;
const decodeBase64 = base64ToUtf8;

// 修复：vmess:// 常用 URL-safe base64 且去掉 padding，直接 atob 会抛错。
// 统一先归一化字符集与长度再解码。
const normalizeBase64 = (str) => {
	let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
	while (s.length % 4) s += '=';
	return s;
};

// 生成伪装错误节点：让客户端能成功解析并把报错信息直接显示在节点列表里
const createErrorNode = (msg) =>
	`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:80?encryption=none&security=none&type=tcp#${encodeURIComponent(msg)}`;

// 把「逗号 / 制表符 / 引号 / 换行」统一成分隔符后切分（原 _worker.js 的 整理()）
const splitList = (content) => {
	if (content === undefined || content === null) return [];
	const s = String(content).replace(/[\t|"'\r\n]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '');
	if (!s) return [];
	return s.split(',').map(x => x.trim()).filter(Boolean);
};

// 环境变量取值：按顺序取第一个「非空」值。
// 用途：同一项支持多个别名（如 ICO / ICON / FAVICON），且空字符串不会覆盖默认值
// —— 在 CF 后台新建变量却留空时，不会把外观项清空。
const pickEnv = (env, ...names) => {
	if (!env) return '';
	for (const name of names) {
		const v = env[name];
		if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
	}
	return '';
};

// 数值型环境变量：带范围钳制，非法值/超范围值一律回落默认，
// 避免后台填错一个数（比如 MAX_IPS=0）把订阅直接打成空。
const numEnv = (env, name, def, min, max) => {
	if (!env) return def;
	const raw = env[name];
	if (raw === undefined || raw === null || String(raw).trim() === '') return def;
	const n = Number(raw);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, Math.floor(n)));
};

// 显式关闭：把某个变量设为 none / off / - / false，可关掉该项（不再回落到 USER_CONFIG）。
// 为什么需要它：空值一律视为「没配」，会回落默认值；而默认值写在代码里，
// 想「不要背景图」「用 emoji 头像」就必须能把默认值显式关掉。
const OFF_SET = new Set(['none', 'off', '-', 'false', 'null']);
const isOff = (env, ...names) => {
	if (!env) return false;
	for (const name of names) {
		if (OFF_SET.has(String(env[name] ?? '').trim().toLowerCase())) return true;
	}
	return false;
};

const moveHttpUrls = (source, target) => {
	if (!Array.isArray(source) || source.length === 0) return source || [];
	const httpUrls = source.filter(x => /^https?:\/\//i.test(x));
	if (httpUrls.length === 0) return source;
	target.push(...httpUrls);
	return source.filter(x => !/^https?:\/\//i.test(x));
};

const hexDigest = async (algo, text) => {
	const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

// 修复：原实现硬依赖 crypto.subtle.digest('MD5')。Cloudflare Workers 支持 MD5，
// 但它是 WebCrypto 的非标准扩展（Node / miniflare 等环境不支持），一旦运行时变化
// 整个请求会直接抛错。这里做一次探测，不支持时降级为 SHA-256。
// 该哈希仅用于生成「对第三方转换后端脱敏」的伪标识，无安全性要求，降级无副作用。
const hashCompat = async (text) => {
	let first;
	try {
		first = await hexDigest('MD5', text);
	} catch {
		first = await hexDigest('SHA-256', text);
	}
	const algo = first.length === 32 ? 'MD5' : 'SHA-256';
	return await hexDigest(algo, first.slice(7, 27));
};

const isValidIPv4 = (address) => {
	const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
	return ipv4Regex.test(address);
};

// 修复：原 parseIP 在任何输入下都不会返回 'N/A'，导致 addIp / batchImport / batchDelete
// 里 `port === 'N/A'` 的格式校验是死代码，非法输入会被当作 `xxx:443` 写库。
// 现在：空输入、正则不匹配、端口越界（1-65535）一律返回 'N/A'，让校验真正生效。
const parseIP = (ip) => {
	const raw = (ip === undefined || ip === null) ? '' : String(ip).trim();
	if (!raw) return { displayIp: '', port: 'N/A', name: '' };
	const match = raw.match(IP_FORMAT_REGEX);
	if (!match) return { displayIp: raw, port: 'N/A', name: '' };
	const displayIp = match[1];
	const name = (match[3] || '').slice(1);
	if (match[2]) {
		const portNum = Number(match[2]);
		if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return { displayIp, port: 'N/A', name };
		return { displayIp, port: match[2], name };
	}
	return { displayIp, port: '443', name };
};

// 修复：原实现用 `new RegExp(地区列表.join('|'))` 做裸子串匹配，导致
//   Network 命中 TW、RUSSIA 命中 US、Australia 命中 US（所有地区都排错）；
// 且 HK / 香港 被当成两个不同地区，同地区的中英名在排序里被拆成两段。
// 现在：ASCII 码用 \b 词边界，中文名用包含匹配，返回值统一归一为地区码。
const extractRegion = (name) => {
	if (!name) return '';
	const s = String(name);
	for (const p of REGION_PATTERNS) {
		if (p.re) { if (p.re.test(s)) return p.code; }
		else if (s.includes(p.alias)) return p.code;
	}
	return '';
};
const getRegionIndex = (region) => region ? (REGION_ORDER.get(region) ?? UNKNOWN_REGION_INDEX) : UNKNOWN_REGION_INDEX;

// ============================================================================
// 3. 请求级运行时（替代原 _worker.js 的模块级全局变量）
// ============================================================================
async function buildRuntime(env, request) {
	const url = new URL(request.url);
	const uaHeader = request.headers.get('User-Agent') || '';
	const ua = uaHeader.toLowerCase();

	const rt = {
		url, uaHeader, ua,
		format: (url.searchParams.get('format') || 'null').toLowerCase(),
		isSubConverterRequest: !!(request.headers.get('subconverter-request') || request.headers.get('subconverter-version') || ua.includes('subconverter')),

		// 节点参数
		host: '', uuid: '', path: '', sni: '', type: 'ws',
		protocol: 'VLESS', alterId: '0', security: 'auto', alpn: '', xhttp: '',
		noTLS: 'false', scv: 'false', tunnelAuthor: 'ed', useProxyIP: 'false', endPS: '',

		// 多源优选
		addList: [], addApiList: [], addNotlsList: [], addNotlsApiList: [], addCsvList: [],
		dls: 7, remarkIndex: 1, proxyIPPool: [],

		// 代理
		proxyIPs: [DEFAULT_PROXYIP], matchProxyIPs: [], socks5Data: null,
		tempRelayDomains: [], tempRelayApi: '',

		// 订阅转换
		subConverter: DEFAULT_SUB_CONVERTER, subProtocol: 'https',
		subConfig: DEFAULT_SUB_CONFIG, subName: DEFAULT_SUB_NAME, subUpdateTime: 6,

		// 风控 / 伪装
		blockUA: [...DEFAULT_BLOCK_UA], url302: null, camoUrls: null,

		// 品牌 / 外观（取值见文件顶部 USER_CONFIG）
		ico: '', avatarUrl: '', avatarFallback: '', bgImages: [], beian: '',
		tgChannel: '', tgGroup: '', author: '',

		// 伪身份（对第三方转换后端脱敏用）
		fakeUserID: '', fakeHostName: '',

		// 其他
		httpsPorts: [...DEFAULT_HTTPS_PORTS], entryTokens: [...DEFAULT_ENTRY_TOKENS],
		link: null, ud: 0, total: 0, expire: 0,
	};

	// --- 可调参数（环境变量覆盖；范围见 CONFIG.md，非法值回落默认） ---
	rt.cacheTtl = numEnv(env, 'CACHE_TTL', CACHE_TTL, 0, 86400);          // 秒，0 = 不缓存
	rt.fetchTimeout = numEnv(env, 'FETCH_TIMEOUT_MS', FETCH_TIMEOUT_MS, 300, 15000);

	// --- 订阅转换后端 ---
	if (env.SUBAPI) {
		let sc = String(env.SUBAPI);
		if (sc.includes('http://')) { sc = sc.split('//')[1] || ''; rt.subProtocol = 'http'; }
		else { sc = sc.split('//')[1] || sc; }
		if (sc) rt.subConverter = sc;
	}
	if (env.SUBCONFIG) rt.subConfig = env.SUBCONFIG;
	rt.subName = pickEnv(env, 'SUBNAME', 'SITENAME', 'TITLE') || USER_CONFIG.siteName || DEFAULT_SUB_NAME;

	// --- 风控 / 伪装 ---
	// 修复：rt.ua 已统一小写，但环境变量里的 UA 没有归一，写 "Telegram" 会永远匹配不到。
	if (env.UA) rt.blockUA = rt.blockUA.concat(splitList(env.UA).map(u => u.toLowerCase()));
	if (env.URL302) rt.url302 = splitList(env.URL302);
	if (env.URL) rt.camoUrls = splitList(env.URL);

	// --- 品牌 / 外观（环境变量 > USER_CONFIG > 内置默认） ---
	// 每个外观项都支持多个别名，方便沿用旧变量名；空值不覆盖默认，见 pickEnv；
	// 设为 none/off/-/false 可显式关闭该项，见 isOff。
	const icoUrl = isOff(env, 'ICO', 'ICON', 'FAVICON') ? '' : (pickEnv(env, 'ICO', 'ICON', 'FAVICON') || USER_CONFIG.icon);
	if (icoUrl) rt.ico = `<link rel="icon" sizes="32x32" href="${icoUrl}">`;

	rt.avatarUrl = isOff(env, 'PNG', 'AVATAR', 'LOGO') ? '' : (pickEnv(env, 'PNG', 'AVATAR', 'LOGO') || USER_CONFIG.avatar || '');
	rt.avatarFallback = pickEnv(env, 'FALLBACK', 'AVATARFALLBACK') || USER_CONFIG.avatarFallback || '📡';

	rt.bgImages = isOff(env, 'IMG', 'BACKGROUND') ? [] : splitList(pickEnv(env, 'IMG', 'BACKGROUND') || USER_CONFIG.background || '');
	rt.beian = isOff(env, 'BEIAN', 'BY', 'FOOTER') ? '' : (pickEnv(env, 'BEIAN', 'BY', 'FOOTER') || USER_CONFIG.footer || '');

	rt.tgChannel = isOff(env, 'TGCHANNEL', 'TG_CHANNEL') ? '' : (pickEnv(env, 'TGCHANNEL', 'TG_CHANNEL') || USER_CONFIG.tgChannel || '');
	rt.tgGroup = isOff(env, 'TGGROUP', 'TG_GROUP') ? '' : (pickEnv(env, 'TGGROUP', 'TG_GROUP') || USER_CONFIG.tgGroup || '');
	rt.author = isOff(env, 'AUTHOR', 'BYNAME') ? '' : (pickEnv(env, 'AUTHOR', 'BYNAME') || USER_CONFIG.author || '');

	// --- 多源优选 ---
	if (env.ADD) rt.addList = splitList(env.ADD);
	if (env.ADDAPI) rt.addApiList = splitList(env.ADDAPI);
	if (env.ADDNOTLS) rt.addNotlsList = splitList(env.ADDNOTLS);
	if (env.ADDNOTLSAPI) rt.addNotlsApiList = splitList(env.ADDNOTLSAPI);
	if (env.ADDCSV) rt.addCsvList = splitList(env.ADDCSV);
	rt.dls = Number(env.DLS) || rt.dls;
	rt.remarkIndex = Number(env.CSVREMARK) || rt.remarkIndex;
	rt.addList = moveHttpUrls(rt.addList, rt.addApiList);
	rt.addNotlsList = moveHttpUrls(rt.addNotlsList, rt.addNotlsApiList);

	// --- 入口 / 端口 / 备注 ---
	if (env.TOKEN) { const t = splitList(env.TOKEN); if (t.length) rt.entryTokens = t; }
	if (env.CFPORTS) { const p = splitList(env.CFPORTS); if (p.length) rt.httpsPorts = p; }
	if (env.PS) rt.endPS = env.PS;
	if (env.ALPN) rt.alpn = env.ALPN;
	if (env.ED) rt.tunnelAuthor = env.ED; // 原实现仅在「内置入口」分支读取 env.ED，但因该值是全局变量会被后续请求继承；此处明确为全局默认值
	if (env.NOTLS) { rt.noTLS = env.NOTLS; rt.noTLSForced = true; }
	rt.scv = env.SCV || rt.scv;

	// --- ProxyIP 池（此处只解析，出网拉取延迟到真正需要时，见 ensureProxySources） ---
	let tmpProxy = [];
	if (env.PROXYIP) tmpProxy = splitList(env.PROXYIP);
	tmpProxy = [...new Set(tmpProxy.filter(x => x && x.trim()))];
	if (tmpProxy.length) rt.proxyIPs = tmpProxy;
	if (env.CMPROXYIPS) rt.matchProxyIPs = splitList(env.CMPROXYIPS);

	// 原 _worker.js 的「临时中转域名接口」是死代码（声明后从未赋值），
	// 这里补上环境变量 RELAYAPI 使其可用。
	rt.tempRelayApi = env.RELAYAPI || '';
	rt.link = env.LINK || null;

	// --- 订阅流量伪装信息 ---
	// 修复：原实现 `total = total * 1099511627776` 在全局变量上累乘，
	// 每次请求都会把 total 再乘一遍，跑一阵子就变成天文数字。改为局部常量。
	const TIMESTAMP = 4102329600000;
	rt.total = 24 * 1099511627776;
	rt.ud = Math.floor(((TIMESTAMP - Date.now()) / TIMESTAMP * 99 * 1099511627776) / 2);
	rt.expire = Math.floor(TIMESTAMP / 1000);

	return rt;
}

// 惰性出网：只在真正需要生成节点时拉取 ProxyIP / SOCKS5 数据源。
// 修复：原实现把这两次 fetch 放在 buildRuntime 里，导致首页、后台 API（含每秒一次的
// 任务轮询）等所有请求都会白白出网拉取一次。
async function ensureProxySources(rt, env) {
	if (rt.proxySourcesReady) return;
	rt.proxySourcesReady = true;

	let tmpProxy = rt.proxyIPs.slice();
	if (env.PROXYIPAPI) {
		const apis = splitList(env.PROXYIPAPI);
		if (apis.length) {
			try {
				const r = await fetch(apis[0]);
				if (r.ok) tmpProxy = tmpProxy.concat(splitList(await r.text()));
			} catch (e) { console.error('[PROXYIPAPI]', e); }
		}
	}
	tmpProxy = [...new Set(tmpProxy.filter(x => x && x.trim()))];
	if (tmpProxy.length) rt.proxyIPs = tmpProxy;

	if (env.SOCKS5DATA) {
		try {
			const r = await fetch(env.SOCKS5DATA);
			rt.socks5Data = (await r.text()).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
		} catch { rt.socks5Data = null; }
	}
}

// 惰性计算：伪身份只用于「对第三方订阅转换后端脱敏」，base64 输出路径根本用不到。
// 修复：原实现每次请求都算两轮哈希，对首页/后台 API 是无谓开销。
async function ensureFakeIdentity(rt) {
	if (rt.fakeUserID) return;
	const fakeHash = await hashCompat(String(Math.ceil(Date.now())));
	rt.fakeUserID = `${fakeHash.slice(0, 8)}-${fakeHash.slice(8, 12)}-${fakeHash.slice(12, 16)}-${fakeHash.slice(16, 20)}-${fakeHash.slice(20)}`;
	rt.fakeHostName = `${fakeHash.slice(6, 9)}.${fakeHash.slice(13, 19)}.xyz`;
}

// host 关键词启发式：含 notls / worker / trycloudflare 时启用无 TLS。
// 修复：原实现该判定位于 if/else 之后的公共段，内置节点入口同样生效；合并后曾在
// 内置入口丢失。现提取为公共函数，两个入口都调用。
// 另外原实现顺序是「先 host 判定，后 env.NOTLS 覆盖」，即 env.NOTLS 优先级更高；
// 这里用 noTLSForced 保持同样的优先级。
function applyHostNotlsHeuristic(rt) {
	if (rt.noTLSForced) return;
	const h = (rt.host || '').toLowerCase();
	if (h.includes('notls') || h.includes('worker') || h.includes('trycloudflare')) rt.noTLS = 'true';
}

// 解析 /sub?host=&uuid=... 形式的节点参数（原 _worker.js else 分支）
function resolveNodeParams(rt) {
	const url = rt.url;
	const q = url.searchParams;
	rt.host = q.get('host') || '';
	rt.uuid = q.get('uuid') || q.get('password') || q.get('pw') || '';
	rt.path = q.get('path') || '';
	rt.sni = q.get('sni') || rt.host;
	rt.type = q.get('type') || rt.type;
	rt.scv = q.get('allowInsecure') === '1' ? 'true' : (q.get('scv') || rt.scv);

	const mode = q.get('mode') || null;
	const extra = q.get('extra') || null;
	rt.xhttp = (mode ? `&mode=${mode}` : '') + (extra ? `&extra=${encodeURIComponent(extra)}` : '');
	// 修复：原实现默认值写成已编码的 'h3%2Ch2'，而输出时还会再 encodeURIComponent 一次，
	// 结果是 alpn=h3%252Ch2（双重编码），客户端解一次只能得到字面量 "h3%2Ch2"。
	// 这里改为原始值 'h3,h2'，由输出层统一编码一次 → alpn=h3%2Ch2。
	rt.alpn = q.get('alpn') || (rt.xhttp ? 'h3,h2' : rt.alpn);
	rt.tunnelAuthor = q.get('edgetunnel') || q.get('epelius') || rt.tunnelAuthor;
	rt.useProxyIP = q.get('proxyip') || 'false';

	if (q.has('alterid')) {
		rt.protocol = 'VMess';
		rt.alterId = q.get('alterid') || rt.alterId;
		rt.security = q.get('security') || rt.security;
	} else if (q.has('edgetunnel') || q.has('uuid')) {
		rt.protocol = 'VLESS';
	} else if (q.has('epelius') || q.has('password') || q.has('pw')) {
		rt.protocol = 'Trojan';
	}

	if (!rt.path || !rt.path.trim()) rt.path = '/?ed=2560';
	else if (rt.path[0] !== '/') rt.path = '/' + rt.path;

	applyHostNotlsHeuristic(rt);
}

// 解析内置节点入口 /{TOKEN} 的参数（原 _worker.js if 分支）
async function resolveBuiltinParams(rt, env) {
	rt.host = 'null';
	if (env.HOST) {
		const hosts = splitList(env.HOST);
		if (hosts.length) rt.host = hosts[Math.floor(Math.random() * hosts.length)];
	}

	if (env.PASSWORD) {
		rt.protocol = 'Trojan';
		rt.uuid = env.PASSWORD;
	} else {
		rt.protocol = 'VLESS';
		if (env.KEY) {
			const r = await buildDynamicUUID(env, rt);
			rt.uuid = r.uuid;
			rt.endPS += r.expireNote;
		} else {
			rt.uuid = env.UUID || 'null';
		}
	}

	rt.path = env.PATH || '/?ed=2560';
	rt.sni = env.SNI || rt.host;
	rt.type = env.TYPE || rt.type;
	rt.tunnelAuthor = env.ED || rt.tunnelAuthor;
	rt.useProxyIP = env.RPROXYIP || 'false';

	if (rt.host === 'null' || rt.uuid === 'null') {
		let missing;
		if (rt.host === 'null' && rt.uuid === 'null') missing = 'HOST/UUID';
		else if (rt.host === 'null') missing = 'HOST';
		else missing = 'UUID';
		rt.endPS += ` 订阅器内置节点 ${missing} 未设置！！！`;
	}

	// 修复：原实现的 host 关键词判定在内置入口同样生效，合并后此处曾丢失
	applyHostNotlsHeuristic(rt);
}

// 按周轮换的动态 UUID（原 _worker.js 的 生成动态UUID）
async function buildDynamicUUID(env, rt) {
	const TZ_OFFSET = 8;
	const validDays = Number(env.TIME) || 7;
	const updateHour = Number(env.UPTIME) || 3;
	const WEEK_MS = 1000 * 60 * 60 * 24 * validDays;
	const startDate = new Date(2007, 6, 7, updateHour, 0, 0);

	const now = new Date();
	const shifted = new Date(now.getTime() + TZ_OFFSET * 60 * 60 * 1000);
	const weekIndex = Math.ceil((Number(shifted) - Number(startDate)) / WEEK_MS);
	const endTime = new Date(startDate.getTime() + weekIndex * WEEK_MS);

	const makeUUID = async (seed) => {
		const h = await hexDigest('SHA-256', seed);
		return `${h.substr(0, 8)}-${h.substr(8, 4)}-4${h.substr(13, 3)}-${(parseInt(h.substr(16, 2), 16) & 0x3f | 0x80).toString(16)}${h.substr(18, 2)}-${h.substr(20, 12)}`;
	};

	const uuid = await makeUUID(env.KEY + weekIndex);
	const expireUTC = new Date(endTime.getTime() - TZ_OFFSET * 60 * 60 * 1000);
	const expireNote = `\n到期时间(UTC): ${expireUTC.toISOString().slice(0, 19).replace('T', ' ')} (UTC+8): ${endTime.toISOString().slice(0, 19).replace('T', ' ')}`;
	return { uuid, expireNote };
}

// ============================================================================
// 4. 多源优选拉取
// ============================================================================
// 修复：原实现多个源共用一个 AbortController 与一个 2s 定时器，
// 任一源超时都会把其它源一起 abort（一个慢源拖垮全部）。现在每个源独立计时。
const fetchTextWithTimeout = async (target, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(target, { method: 'GET', headers, signal: controller.signal });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		return await resp.text();
	} finally {
		clearTimeout(timer);
	}
};

// 拉取 API 型优选源（支持 CSV 格式带 id=/port= 备注，也支持纯文本）
async function fetchApiList(apiUrls, rt) {
	const out = { list: [], proxyPool: [] };
	if (!apiUrls || apiUrls.length === 0) return out;

	let merged = '';
	try {
		const responses = await Promise.allSettled(apiUrls.map(u => fetchTextWithTimeout(u, {
			'Accept': 'text/html,application/xhtml+xml,application/xml;',
			'User-Agent': `${rt.subName} (https://github.com/cmliu/WorkerVless2sub)`,
		}, rt.fetchTimeout)));

		for (const [index, response] of responses.entries()) {
			if (response.status !== 'fulfilled') continue;
			const content = response.value;
			const lines = content.split(/\r?\n/);
			const head = lines[0] || '';

			if (head.split(',').length > 3) {
				let nodeRemark = '';
				let speedPort = '443';
				const idMatch = apiUrls[index].match(/id=([^&]*)/);
				if (idMatch) nodeRemark = idMatch[1];
				const portMatch = apiUrls[index].match(/port=([^&]*)/);
				if (portMatch) speedPort = portMatch[1];

				for (let i = 1; i < lines.length; i++) {
					const col = lines[i].split(',')[0];
					if (!col) continue;
					merged += `${col}:${speedPort}${nodeRemark ? `#${nodeRemark}` : ''}\n`;
					if (apiUrls[index].includes('proxyip=true')) out.proxyPool.push(`${col}:${speedPort}`);
				}
			} else {
				if (apiUrls[index].includes('proxyip=true')) {
					out.proxyPool.push(...splitList(content).map(item => {
						const base = item.split('#')[0] || item;
						if (base.includes(':')) {
							const port = base.split(':')[1];
							return rt.httpsPorts.includes(port) ? null : base;
						}
						return `${base}:443`;
					}).filter(Boolean));
				}
				merged += content + '\n';
			}
		}
	} catch (e) {
		console.error('[fetchApiList]', e);
	}

	out.list = splitList(merged);
	return out;
}

// 拉取测速 CSV 优选源（按 TLS 列 + 速度阈值 DLS 过滤）
async function fetchCsvList(csvUrls, tls, rt) {
	if (!tls || !Array.isArray(csvUrls) || csvUrls.length === 0) return [];

	const parseCSV = (text) => text
		.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
		.filter(line => line.trim() !== '')
		.map(line => line.split(',').map(cell => cell.trim()));

	const results = await Promise.all(csvUrls.map(async (csvUrl) => {
		try {
			const rows = parseCSV(await fetchTextWithTimeout(csvUrl, {
				'Accept': 'text/csv,text/plain,*/*',
				'User-Agent': `${rt.subName} (CSV)`,
			}, rt.fetchTimeout));
			const [header, ...dataRows] = rows;
			const tlsIndex = header.findIndex(col => col.toUpperCase() === 'TLS');
			if (tlsIndex === -1) throw new Error('CSV 文件缺少必需的 TLS 字段');

			return dataRows
				.filter(row => {
					const tlsValue = (row[tlsIndex] || '').toUpperCase();
					const speed = parseFloat(row[row.length - 1]);
					return tlsValue === tls.toUpperCase() && speed > rt.dls;
				})
				.map(row => {
					const ipAddress = row[0];
					const port = row[1];
					// 修复（P2-2）：原实现直接取 row[tlsIndex + remarkIndex]，
					// CSV 缺「数据中心」列时会把速度列当备注（静默错位）。
					// 现在要求备注列必须严格位于 TLS 列与末列（速度）之间，否则视为无备注。
					const remarkIdx = tlsIndex + rt.remarkIndex;
					const speedIdx = row.length - 1;
					const remarkCell = (remarkIdx > tlsIndex && remarkIdx < speedIdx) ? (row[remarkIdx] || '').trim() : '';
					if (csvUrl.includes('proxyip=true') && (row[tlsIndex] || '').toUpperCase() === 'TRUE' && !rt.httpsPorts.includes(port)) {
						rt.proxyIPPool.push(`${ipAddress}:${port}`);
					}
					return `${ipAddress}:${port}${remarkCell ? `#${remarkCell}` : ''}`;
				});
		} catch (error) {
			console.error(`[fetchCsvList] ${csvUrl}:`, error);
			return [];
		}
	}));

	return results.flat();
}

// 拉取订阅链接并抽出节点（原 _worker.js 的 getLink）
async function fetchLinkedNodes(links, rt) {
	const nodeLinks = [];
	const subUrls = [];
	for (const x of links) {
		if (x.toLowerCase().startsWith('http')) subUrls.push(x);
		else nodeLinks.push(x);
	}
	if (subUrls.length === 0) return nodeLinks;

	try {
		const responses = await Promise.allSettled(subUrls.map(u => fetchTextWithTimeout(u, {
			'Accept': 'text/html,application/xhtml+xml,application/xml;',
			'User-Agent': `v2rayN/${rt.subName} (https://github.com/cmliu/WorkerVless2sub)`,
		}, rt.fetchTimeout)));

		for (const response of responses) {
			if (response.status !== 'fulfilled') continue;
			const content = response.value || '';
			if (content.includes('://')) {
				nodeLinks.push(...(content.includes('\r\n') ? content.split('\r\n') : content.split('\n')));
				continue;
			}
			// 修复：原实现 base64 解码无异常保护，非 base64 内容会直接抛错中断整个请求
			try {
				const decoded = base64ToUtf8(normalizeBase64(content));
				if (decoded.includes('://')) {
					nodeLinks.push(...(decoded.includes('\r\n') ? decoded.split('\r\n') : decoded.split('\n')));
				}
			} catch { /* 非 base64 内容，忽略 */ }
		}
	} catch (e) {
		console.error('[fetchLinkedNodes]', e);
	}
	return nodeLinks;
}

// ============================================================================
// 5. 节点构建
// ============================================================================
// 裂变：把优选 IP 套进用户给定的基础节点链接（worker.js 原有能力）
const multiplexLink = (baseLink, premiumIpRow) => {
	const { displayIp, port, name } = parseIP(premiumIpRow.ip);
	const nodeName = premiumIpRow.name || name || displayIp;

	try {
		if (baseLink.startsWith('vless://') || baseLink.startsWith('trojan://')) {
			const url = new URL(baseLink);
			const originalHost = url.hostname;
			url.hostname = displayIp;
			if (port && port !== 'N/A') url.port = port;
			url.hash = nodeName; // 直接赋值，URL 对象自动编码，避免双重编码导致客户端报错
			if (!url.searchParams.has('host') && originalHost) url.searchParams.set('host', originalHost);
			if (!url.searchParams.has('sni') && originalHost) url.searchParams.set('sni', originalHost);
			return url.toString();
		}
		if (baseLink.startsWith('vmess://')) {
			const b64 = normalizeBase64(baseLink.slice(8));
			const config = JSON.parse(decodeBase64(b64));
			if (!config.sni) config.sni = config.add;
			if (!config.host) config.host = config.add;
			config.add = displayIp;
			if (port && port !== 'N/A') config.port = port;
			config.ps = nodeName;
			return 'vmess://' + encodeBase64(JSON.stringify(config));
		}
	} catch (e) {
		return null;
	}
	return null;
};

// 生成器：用优选 IP + host/uuid/path 直接构建节点（_worker.js 特有）
function buildNodeLink(address, rt, useTLS) {
	let port = '-1';
	let addressid = address;
	let addr = address;

	const match = address.match(NODE_IP_REGEX);
	if (!match) {
		if (addr.includes(':') && addr.includes('#')) {
			const parts = addr.split(':');
			addr = parts[0];
			const sub = parts[1].split('#');
			port = sub[0];
			addressid = sub[1];
		} else if (addr.includes(':')) {
			const parts = addr.split(':');
			addr = parts[0];
			port = parts[1];
		} else if (addr.includes('#')) {
			const parts = addr.split('#');
			addr = parts[0];
			addressid = parts[1];
		}
		if (addressid.includes(':')) addressid = addressid.split(':')[0];
	} else {
		addr = match[1];
		port = match[2] || port;
		addressid = match[3] || addr;
	}

	const ports = useTLS ? rt.httpsPorts : HTTP_PORTS;
	if (!isValidIPv4(addr) && port === '-1') {
		for (const p of ports) {
			if (addr.includes(p)) { port = p; break; }
		}
	}
	if (port === '-1') port = useTLS ? '443' : '80';

	// 修复：原实现把 path / sni 写回模块级全局变量，在 .map() 循环里逐个节点覆盖，
	// 导致同一批节点之间互相串味（前一个节点的 path 会被后一个继承）。
	// 这里全部用循环内局部变量。
	let nodePath = rt.path;
	let nodeSni = rt.sni;
	let camoHost = rt.host;
	let remark = rt.endPS;

	if (rt.tunnelAuthor.trim() === 'cmliu' && rt.useProxyIP.trim() === 'true') {
		const lowerId = addressid.toLowerCase();
		if (rt.socks5Data && rt.socks5Data.length) {
			// 修复：SOCKS5 数据源格式为 host:port#地区，选择后直接拼进 path 会把 `#地区`
			// 一起带进去（path=/host:port#us），服务端解析目标时会得到非法值。这里去掉地区后缀。
			const picked = String(getRandomProxyByMatch(lowerId, rt.socks5Data) || '').split('#')[0].trim();
			if (picked) nodePath = `/${picked}`;
		} else {
			let found = null;
			for (const item of rt.matchProxyIPs) {
				if (item.includes('#') && item.split('#')[1] && lowerId.includes(item.split('#')[1].toLowerCase())) { found = item.split('#')[0]; break; }
				if (item.includes(':') && item.split(':')[1] && lowerId.includes(item.split(':')[1].toLowerCase())) { found = item.split(':')[0]; break; }
			}
			const pooled = rt.proxyIPPool.find(p => p.includes(addr));
			if (pooled) nodePath = '/proxyip=' + pooled;
			else if (found) nodePath = '/proxyip=' + found;
			else nodePath = '/proxyip=' + rt.proxyIPs[Math.floor(Math.random() * rt.proxyIPs.length)];
		}
	}

	if (useTLS && rt.tempRelayDomains.length > 0 && rt.host.includes('.workers.dev')) {
		nodePath = `/${rt.host}${nodePath}`;
		camoHost = rt.tempRelayDomains[Math.floor(Math.random() * rt.tempRelayDomains.length)];
		remark = rt.endPS + '已启用临时域名中转服务，请尽快绑定自定义域！';
		nodeSni = camoHost;
	}

	const alpnEnc = encodeURIComponent(rt.alpn);
	if (rt.protocol === 'VMess') {
		const cfg = {
			v: '2',
			ps: addressid + remark,
			add: addr,
			port: String(port),
			id: rt.uuid,
			aid: rt.alterId,
			scy: rt.security,
			net: 'ws',
			type: rt.type,
			host: camoHost,
			path: nodePath,
			tls: useTLS ? 'tls' : '',
			sni: useTLS ? nodeSni : '',
			alpn: alpnEnc,
			fp: '',
			allowInsecure: rt.scv === 'true' ? '1' : '0',
			fragment: '1,40-60,30-50,tlshello',
		};
		return 'vmess://' + utf8ToBase64(JSON.stringify(cfg));
	}

	if (!useTLS) {
		// 无 TLS：仅 VLESS 走这条（Trojan 必须 TLS）
		return `vless://${rt.uuid}@${addr}:${port}?security=&type=${rt.type}&host=${camoHost}&path=${encodeURIComponent(nodePath)}&encryption=none#${encodeURIComponent(addressid + remark)}`;
	}

	if (rt.protocol === 'Trojan') {
		return `trojan://${rt.uuid}@${addr}:${port}?security=tls&sni=${nodeSni}&alpn=${alpnEnc}&fp=random&type=${rt.type}&host=${camoHost}&path=${encodeURIComponent(nodePath) + (rt.scv === 'true' ? '&allowInsecure=1' : '')}&fragment=${encodeURIComponent('1,40-60,30-50,tlshello')}#${encodeURIComponent(addressid + remark)}`;
	}

	return `vless://${rt.uuid}@${addr}:${port}?security=tls&sni=${nodeSni}&alpn=${alpnEnc}&fp=random&type=${rt.type}&host=${camoHost}&path=${encodeURIComponent(nodePath) + rt.xhttp + (rt.scv === 'true' ? '&allowInsecure=1' : '')}&fragment=${encodeURIComponent('1,40-60,30-50,tlshello')}&encryption=none#${encodeURIComponent(addressid + remark)}`;
}

// 汇总某一类（TLS / 无 TLS）的全部优选地址
async function collectAddresses(rt, useTLS, env) {
	await ensureProxySources(rt, env);
	const staticList = useTLS ? rt.addList : rt.addNotlsList;
	const apiList = useTLS ? rt.addApiList : rt.addNotlsApiList;

	const { list: fromApi, proxyPool } = await fetchApiList(apiList, rt);
	if (proxyPool.length) rt.proxyIPPool.push(...proxyPool);

	const fromCsv = await fetchCsvList(rt.addCsvList, useTLS ? 'TRUE' : 'FALSE', rt);
	return [...new Set([...staticList, ...fromApi, ...fromCsv].filter(x => x && x.trim()))];
}

// 从 D1 私有库取启用的优选地址（转成 `ip:port#备注` 形式，供 buildNodeLink 复用备注）
async function loadD1Addresses(env) {
	if (!env || !env.DB) return [];
	try {
		const maxIps = numEnv(env, 'MAX_IPS', MAX_IPS, 1, 5000);
		const { results } = await env.DB.prepare('SELECT ip, name FROM ips WHERE active=1 ORDER BY priority, id LIMIT ?')
			.bind(maxIps).all();
		return (results || [])
			.map(r => (r && r.name ? `${r.ip}#${r.name}` : (r && r.ip)))
			.filter(Boolean);
	} catch (e) {
		console.error('[loadD1Addresses]', e);
		return [];
	}
}

// 生成器模式的地址来源解析。
// 修复（v1.2）：原实现只读环境变量 ADD / ADDAPI / ADDCSV（+ URL 覆盖），完全不查 D1 私有库，
// 也不认 `source` 参数。于是「在后台导入了优选 IP、直接打开 /gen 生成订阅」的用户
// 一定拿到 `❌ 没有生成任何可用节点(请检查优选源与节点参数)`。
// 现在的语义：
//   source=local  → 只用 D1 私有库
//   source=multi  → 只用环境变量 / URL 多源（不回退）
//   source=ext    → 外部优选库（需 ext_url）
//   未指定        → 先用环境变量 / URL 多源，为空则回退 D1（与裂变模式默认来源一致）
async function collectGeneratorAddresses(rt, env, useTLS) {
	const source = rt.url.searchParams.get('source');

	if (source === 'ext') {
		// 外部库是 443 优选库，不参与无 TLS 节点
		if (!useTLS) return [];
		try {
			const rows = await loadIpRows(env, rt);
			return rows.map(r => (r.name ? `${r.ip}#${r.name}` : r.ip)).filter(Boolean);
		} catch (e) {
			// 不把异常抛到 /sub 顶层（那里会统一包成「订阅生成失败: …」），
			// 先记下来，交给 describeGeneratorSources 出可读诊断
			console.error('[gen:ext]', e);
			rt.extError = (e && e.message) || String(e);
			return [];
		}
	}
	if (source === 'local') return useTLS ? await loadD1Addresses(env) : [];

	const list = await collectAddresses(rt, useTLS, env);
	if (list.length || source === 'multi' || !useTLS) return list;
	return await loadD1Addresses(env);
}

// 生成失败时给出可自查的来源诊断，替代原来含糊的「请检查优选源与节点参数」
async function describeGeneratorSources(rt, env) {
	const source = rt.url.searchParams.get('source');
	const items = [];

	const d1Detail = async () => {
		if (!env || !env.DB) return '未绑定 D1';
		try {
			const row = await env.DB.prepare('SELECT COUNT(*) as n FROM ips WHERE active=1').first();
			return `私有库启用 ${(row && row.n) || 0} 条`;
		} catch {
			return '私有库查询失败';
		}
	};

	// 显式单一来源时只报该来源，避免列出未参与取址的其它源造成误导
	if (source === 'ext') {
		const extUrl = rt.url.searchParams.get('ext_url');
		if (!extUrl) items.push('外部库未填 ext_url');
		else if (rt.extError) items.push(`外部库拉取失败：${rt.extError}`);
		else items.push('外部库 0 条');
		return items.join(' / ');
	}
	if (source === 'local') return await d1Detail();

	if (rt.addList.length) items.push(`ADD ${rt.addList.length} 条`);
	if (rt.addApiList.length) items.push(`ADDAPI ${rt.addApiList.length} 个`);
	if (rt.addCsvList.length) items.push(`ADDCSV ${rt.addCsvList.length} 个`);
	if (rt.addNotlsList.length) items.push(`ADDNOTLS ${rt.addNotlsList.length} 条`);

	// source=multi 明确不读 D1，诊断里就不该出现私有库条数，
	// 否则用户会以为「库里明明有 IP 却没被用」——那正是选 multi 的预期行为。
	if (source === 'multi') return items.join(' / ') || '环境变量 ADD / ADDAPI / 测速 CSV 均无有效地址';

	items.push(await d1Detail());
	return items.join(' / ');
}

// 生成器模式主流程
async function buildGeneratorLinks(rt, env) {
	// 临时中转域名：仅当 host 是 workers.dev 时按需拉取（原实现该分支是死代码）
	if (rt.tempRelayApi && rt.host.includes('workers.dev')) {
		try {
			const resp = await fetch(rt.tempRelayApi);
			if (resp.ok) {
				const lines = (await resp.text()).split('\n').map(l => l.trim()).filter(Boolean);
				rt.tempRelayDomains = [...new Set(rt.tempRelayDomains.concat(lines))];
			}
		} catch (e) { console.error('[RELAYAPI]', e); }
	}

	// 修复：原实现在 subconverter 回源请求时会清空 alpn，避免转换后端误处理
	if (rt.isSubConverterRequest) rt.alpn = '';

	const tlsAddresses = await collectGeneratorAddresses(rt, env, true);
	const parts = tlsAddresses.map(a => buildNodeLink(a, rt, true)).filter(Boolean);

	// 修复（P2-3）：原条件是 `(noTLS && VLESS) || VMess`，VMess 且 noTLS=false 时
	// 仍会去抓一次 ADDNOTLSAPI，抓回来又被 `rt.noTLS === 'true'` 丢掉（白跑一次出网）。
	// 现在只有真正要输出无 TLS 节点时才抓；Trojan 必须 TLS，不参与。
	const needNotls = rt.noTLS === 'true' && rt.protocol !== 'Trojan';
	if (needNotls) {
		const notlsAddresses = await collectAddresses(rt, false, env);
		const notlsNodes = notlsAddresses.map(a => buildNodeLink(a, rt, false)).filter(Boolean);
		if (notlsNodes.length) parts.push(...notlsNodes);
	}

	if (rt.link) {
		const links = splitList(rt.link);
		if (links.length) {
			const extra = (await fetchLinkedNodes(links, rt)).filter(x => x && x.includes('://'));
			if (extra.length) parts.push(...extra);
		}
	}

	return parts.join('\n');
}

// ============================================================================
// 6. 输出层：base64 / Clash / sing-box / Surge
// ============================================================================
// 修复：原实现用 new RegExp(uuid/host) 做替换，uuid/host 里的正则元字符会直接抛错。
// 改用 split/join 做字面量替换。
//
// 修复（P0-1 / P2-12）：
//  1) 原实现要求 fakeUserID && uuid && host 三者齐全才脱敏，而裂变模式从不解析 base 链接，
//     uuid/host 恒为空 → 脱敏整体失效，真实凭据被明文发给第三方转换后端。
//     现在改为「按字段独立脱敏」：只要该字段可脱敏就替换，另一个字段缺失不影响。
//  2) 内置节点模式未配 HOST/UUID 时，rt.host / rt.uuid 就是字符串 'null'，
//     原先会把全文所有 "null" 替换掉。现在 'null' 与过短值一律不参与替换。
//  3) 增加 urlencoded 变体的替换，覆盖 base= 参数里被百分号编码的凭据。
const isMaskableValue = (v) => typeof v === 'string' && v.length >= 4 && v !== 'null';

const replaceAll = (content, from, to) => (isMaskableValue(from) && to) ? content.split(from).join(to) : content;

const applyFake = (content, rt) => {
	if (!rt.fakeUserID) return content;
	let out = replaceAll(content, rt.uuid, rt.fakeUserID);
	const encUuid = encodeURIComponent(rt.uuid || '');
	if (encUuid && encUuid !== rt.uuid) out = out.split(encUuid).join(rt.fakeUserID);
	out = replaceAll(out, rt.host, rt.fakeHostName);
	const encHost = encodeURIComponent(rt.host || '');
	if (encHost && encHost !== rt.host) out = out.split(encHost).join(rt.fakeHostName);
	return out;
};
const revertFake = (content, rt) => {
	if (!rt.fakeUserID) return content;
	let out = replaceAll(content, rt.fakeUserID, rt.uuid);
	out = replaceAll(out, rt.fakeHostName, rt.host);
	return out;
};

// 从用户提交的基础节点链接里抽出 uuid(密码) 与 host(伪装域名)。
// 修复（P0-1）：裂变模式的脱敏依赖这两个值，原先只在生成器模式解析。
function extractBaseCredentials(baseLink) {
	const out = { uuid: '', host: '' };
	if (typeof baseLink !== 'string' || !baseLink) return out;
	try {
		if (baseLink.startsWith('vmess://')) {
			const b64 = normalizeBase64(baseLink.slice(8));
			const cfg = JSON.parse(base64ToUtf8(b64));
			out.uuid = cfg.id || '';
			out.host = cfg.host || cfg.sni || cfg.add || '';
		} else if (baseLink.startsWith('vless://') || baseLink.startsWith('trojan://')) {
			const u = new URL(baseLink);
			out.uuid = decodeURIComponent(u.username || '');
			out.host = u.searchParams.get('host') || u.searchParams.get('sni') || u.hostname || '';
		}
	} catch { /* 解析失败则保持空值，退化为不脱敏（与旧行为一致，不阻断订阅） */ }
	return out;
}

function resolveTarget(rt) {
	const ua = rt.ua;
	if (rt.isSubConverterRequest) return 'base64';

	// 修复：显式 format 参数优先，且不受协议限制。
	// 原实现把 surge 绑在「协议 == Trojan」上，导致裂变模式（协议未知，默认 VLESS）
	// 即使显式指定 format=surge 也会被静默降级为 base64。
	if (rt.format === 'clash') return 'clash';
	if (rt.format === 'singbox') return 'singbox';
	if (rt.format === 'surge') return 'surge';

	if (ua.includes('cf-workers-sub')) return 'base64';
	if ((ua.includes('clash') || ua.includes('meta') || ua.includes('mihomo')) && !ua.includes('nekobox')) return 'clash';
	if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox';
	if (rt.protocol === 'Trojan' && ua.includes('surge')) return 'surge';
	return 'base64';
}

const subscriptionHeaders = (rt) => {
	const h = {
		'Content-Type': 'text/plain; charset=utf-8',
		'Profile-Update-Interval': String(rt.subUpdateTime),
		'Profile-web-page-url': rt.url.origin,
		// 修复（P1-3）：rt.total / rt.ud / rt.expire 原先算完从未使用（死代码）。
		// 现在真正输出为标准订阅流量头，客户端会显示用量与到期，起到伪装作用。
		'Subscription-Userinfo': `upload=0; download=${rt.ud}; total=${rt.total}; expire=${rt.expire}`,
		// CACHE_TTL 可由环境变量覆盖；设为 0 时明确不缓存（no-store），便于调试
		'Cache-Control': rt.cacheTtl > 0 ? `public, max-age=${rt.cacheTtl}` : 'no-store',
	};
	if (!rt.ua.includes('mozilla')) h['Content-Disposition'] = `attachment; filename*=utf-8''${encodeURIComponent(rt.subName)}`;
	return h;
};

async function formatSubscription(nodeLinks, rt, request) {
	const target = resolveTarget(rt);
	const headers = subscriptionHeaders(rt);

	if (target === 'base64') return new Response(encodeBase64(nodeLinks), { headers });

	// 走外部订阅转换后端（对后端做 uuid/host 脱敏）——此处才需要伪身份
	await ensureFakeIdentity(rt);
	let sourceUrl = applyFake(rt.url.href, rt);

	if (target === 'singbox' && rt.protocol === 'VMess' && rt.url.href.includes('path=')) {
		const parts = rt.url.href.split('path=');
		const segs = parts[1].split('&');
		const head = segs[0] || '';
		const tail = segs.slice(1).join('&') || '';
		if (head.includes('%3F')) {
			sourceUrl = applyFake(parts[0] + 'path=' + head.split('%3F')[0] + '&' + tail, rt);
		}
	}

	let converterUrl;
	if (target === 'surge') {
		// Surge 走「节点串直传」通道（与原实现一致）
		// 修复（P2-13）：subconverter 用 `|` 分帧节点，备注里出现 `|` 会把节点拆坏，先做全角替换。
		const joined = applyFake(nodeLinks.split('|').join('｜').split('\n').join('|'), rt);
		converterUrl = `${rt.subProtocol}://${rt.subConverter}/sub?target=surge&ver=4&url=${encodeURIComponent(joined)}&insert=false&config=${encodeURIComponent(rt.subConfig)}&emoji=true&list=false&xudp=false&udp=false&tfo=false&expand=true&scv=${rt.scv}&fdn=false`;
	} else {
		const params = new URLSearchParams({
			target,
			url: sourceUrl,
			insert: 'false',
			config: rt.subConfig,
			emoji: 'true',
			list: 'false',
			tfo: 'false',
			scv: rt.scv,
			fdn: 'false',
			sort: 'false',
			new_name: 'true',
		});
		converterUrl = `${rt.subProtocol}://${rt.subConverter}/sub?${params.toString()}`;
	}

	try {
		const resp = await fetch(converterUrl, {
			headers: { 'User-Agent': `v2rayN/${rt.subName} (https://github.com/cmliu/EdgeOne-Pages-BestIP2SUB)` },
		});
		if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
		let content = await resp.text();
		if (target === 'surge') content = surgeTransform(content, rt);
		content = revertFake(content, rt);
		return new Response(content, { headers });
	} catch (error) {
		return textResponse(`订阅转换失败: ${error.message}`, 500);
	}
}

// Surge 输出修补：把 subconverter 生成的 trojan 行补上 ws 参数
function surgeTransform(content, rt) {
	const lines = content.includes('\r\n') ? content.split('\r\n') : content.split('\n');
	let out = '';
	for (const line of lines) {
		if (line.includes('= trojan,')) {
			const host = line.split('sni=')[1] ? line.split('sni=')[1].split(',')[0] : '';
			const from = 'skip-cert-verify=true, tfo=false, udp-relay=false';
			const to = `skip-cert-verify=true, ws=true, ws-path=${rt.path}, ws-headers=Host:"${host}", tfo=false, udp-relay=false`;
			out += line.split(from).join(to).replace('[', '').replace(']', '') + '\n';
		} else {
			out += line + '\n';
		}
	}
	const firstNewline = out.indexOf('\n');
	return `#!MANAGED-CONFIG ${rt.url.href} interval=86400 strict=false` + (firstNewline >= 0 ? out.substring(firstNewline) : '');
}

function getRandomProxyByMatch(cc, socks5Data) {
	const lower = cc.toLowerCase();
	let filtered = socks5Data.filter(p => p.toLowerCase().endsWith(`#${lower}`));
	if (filtered.length === 0) filtered = socks5Data.filter(p => p.toLowerCase().endsWith('#us'));
	if (filtered.length === 0) return socks5Data[Math.floor(Math.random() * socks5Data.length)];
	return filtered[Math.floor(Math.random() * filtered.length)];
}

// ============================================================================
// 7. 伪装与通知
// ============================================================================
const nginxPage = () => `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
	body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;

// 命中伪装规则时返回：nginx 假页 / 302 跳转 / 反向代理
async function handleCamouflage(request, rt) {
	const urls = rt.url302 || rt.camoUrls;
	const isRedirect = !!rt.url302;
	if (urls && urls.length) {
		if (urls.includes('nginx')) return new Response(nginxPage(), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
		const target = urls[Math.floor(Math.random() * urls.length)];
		return isRedirect ? Response.redirect(target, 302) : fetch(new Request(target, request));
	}
	return null;
}

async function sendTelegramNotice(env, type, ip, addData = '') {
	if (!env.TGTOKEN || !env.TGID) return;
	try {
		// 修复（P2-14）：parse_mode=HTML 时字段里的 < & > 会让 Telegram 直接 400 静默失败
		const escHtml = (s) => String(s === undefined || s === null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		let msg;
		const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN`);
		if (response.ok) {
			const info = await response.json();
			msg = `${escHtml(type)}\nIP: ${escHtml(ip)}\n国家: ${escHtml(info.country)}\n<tg-spoiler>城市: ${escHtml(info.city)}\n组织: ${escHtml(info.org)}\nASN: ${escHtml(info.as)}\n${escHtml(addData)}`;
		} else {
			msg = `${escHtml(type)}\nIP: ${escHtml(ip)}\n<tg-spoiler>${escHtml(addData)}`;
		}
		await fetch(`https://api.telegram.org/bot${env.TGTOKEN}/sendMessage?chat_id=${env.TGID}&parse_mode=HTML&text=${encodeURIComponent(msg)}`, {
			method: 'GET',
			headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;', 'User-Agent': 'Mozilla/5.0 Chrome/90.0.4430.72' },
		});
	} catch (error) {
		console.error('[sendTelegramNotice]', error);
	}
}

// ============================================================================
// 8. D1 数据层 + 任务缓存（worker.js 原有）
// ============================================================================
const taskCache = new Map();

// 修复（P2-7/P2-15）：返回每批结果，供调用方统计真实影响行数；单批失败会抛错由上层捕获。
const execBatches = async (db, statements) => {
	const out = [];
	const len = statements.length;
	if (len === 0) return out;
	for (let i = 0; i < len; i += BATCH_SIZE) {
		const part = await db.batch(statements.slice(i, Math.min(i + BATCH_SIZE, len)));
		if (Array.isArray(part)) out.push(...part);
	}
	return out;
};

// 全表遍历（分页），避免一次性把大表读进内存、也避开 D1 单次返回行数上限
const selectAllRows = async (db, baseSql) => {
	const out = [];
	for (let offset = 0; ; offset += DB_PAGE_SIZE) {
		const { results } = await db.prepare(`${baseSql} LIMIT ? OFFSET ?`).bind(DB_PAGE_SIZE, offset).all();
		out.push(...results);
		if (results.length < DB_PAGE_SIZE) break;
	}
	return out;
};

const saveTask = async (kv, id, status, msg = '') => {
	const data = { status, message: msg, timestamp: Date.now() };
	taskCache.set(id, data);
	setTimeout(() => taskCache.delete(id), TASK_TTL * 1000);
	if (kv) await kv.put(`task:${id}`, JSON.stringify(data), { expirationTtl: TASK_TTL }).catch(() => {});
};

const getTask = async (kv, id) => {
	const cached = taskCache.get(id);
	if (cached) return cached;
	if (kv) {
		try {
			const data = await kv.get(`task:${id}`, { type: 'json' });
			if (data) { taskCache.set(id, data); return data; }
		} catch { /* ignore */ }
	}
	return null;
};

const getDataVersion = async (kv) => {
	if (!kv) return '0';
	try { return String((await kv.get(DATA_VERSION_KEY)) || '0'); } catch { return '0'; }
};
const bumpDataVersion = async (kv) => {
	if (!kv) return;
	try {
		const v = Number(await kv.get(DATA_VERSION_KEY)) || 0;
		await kv.put(DATA_VERSION_KEY, String(v + 1));
	} catch { /* ignore */ }
};

// 修复（P2-21）：除统计缓存外，同时自增数据版本号，让 /sub 的边缘缓存键失效
const invalidateCache = async (kv) => {
	if (!kv) return;
	await kv.delete(STATS_CACHE_KEY).catch(() => {});
	await bumpDataVersion(kv);
};

const getCachedStats = async (kv) => {
	if (!kv) return null;
	try { return await kv.get(STATS_CACHE_KEY, { type: 'json' }); } catch { return null; }
};
const setCachedStats = async (kv, stats, ttl = CACHE_TTL) => {
	if (kv && ttl > 0) await kv.put(STATS_CACHE_KEY, JSON.stringify(stats), { expirationTtl: ttl }).catch(() => {});
};

const performIdReorder = async (db, sortedIds) => {
	if (sortedIds.length === 0) return;
	const tempStmts = sortedIds.map((id, i) => db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(-(i + 1), id));
	const finalStmts = sortedIds.map((_, i) => db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(i + 1, -(i + 1)));
	await execBatches(db, tempStmts);
	try {
		await execBatches(db, finalStmts);
	} catch (e) {
		// 修复（P2-15）：两阶段改 ID 中途失败会留下负 ID，后台看起来像数据丢了。
		// 这里尽力把负数 ID 还原回原 ID（可能因已转正的 ID 冲突而部分失败，故为 best-effort）。
		try {
			await execBatches(db, sortedIds.map((id, i) => db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(id, -(i + 1))));
		} catch { /* 回滚失败则保留现状，由任务错误信息暴露 */ }
		throw e;
	}
};

// 按 IP 归一去重键（忽略端口）。修复（P0-2）：原实现用
// SUBSTR(ip, 1, INSTR(ip, ':') - 1) 分组，带方括号的 IPv6（[::1]:443）
// 分组键恒为 "["，一次「清理重复」会把所有 IPv6 删到只剩 1 条。
const ipDedupKey = (ip) => {
	const s = String(ip || '').trim().toLowerCase();
	const v6 = s.match(/^\[([^\]]+)\]/);
	if (v6) return v6[1];
	const idx = s.lastIndexOf(':');
	return idx > 0 ? s.slice(0, idx) : s;
};

// ============================================================================
// 9. 后台管理 API
// ============================================================================
const api = {
	async getIps(db, params, env) {
		const page = Math.max(1, parseInt(params.get('page')) || 1);
		const pageSize = numEnv(env, 'PAGE_SIZE', PAGE_SIZE, 1, 100);
		const limit = Math.min(100, Math.max(1, parseInt(params.get('limit')) || pageSize));
		const offset = (page - 1) * limit;
		const needTotal = params.get('needTotal') === 'true';
		const keyword = params.get('keyword') || '';

		let baseQuery = 'FROM ips';
		const bindings = [];
		if (keyword) {
			baseQuery += ' WHERE ip LIKE ? OR name LIKE ?';
			bindings.push(`%${keyword}%`, `%${keyword}%`);
		}

		const queries = [
			db.prepare(`SELECT id, ip, name, active, priority ${baseQuery} ORDER BY id LIMIT ? OFFSET ?`)
				.bind(...bindings, limit, offset),
		];
		if (needTotal) queries.push(db.prepare(`SELECT COUNT(*) as total ${baseQuery}`).bind(...bindings));

		const results = await db.batch(queries);
		const ips = results[0].results.map(r => {
			const { displayIp, port } = parseIP(r.ip);
			return { ...r, displayIp, port, region: extractRegion(r.name) };
		});

		const pagination = { page, limit };
		if (needTotal) {
			pagination.total = results[1].results[0].total;
			pagination.pages = Math.ceil(pagination.total / limit) || 1;
		}
		return json({ ips, pagination });
	},

	async getStats(db, kv, env) {
		const cached = await getCachedStats(kv);
		if (cached) return json(cached);
		const row = await db.prepare('SELECT COUNT(*) as total, SUM(active) as active FROM ips').first();
		const total = row.total || 0;
		const active = row.active || 0;
		const maxIps = numEnv(env, 'MAX_IPS', MAX_IPS, 1, 5000);
		// 修复（P2-8）：MAX_IPS 只限制订阅读取、不限制导入，超出的部分会静默不参与订阅。
		// 这里把上限暴露给前端，让后台能显示「订阅最多取前 N 条」。
		const stats = { total, active, inactive: total - active, limit: maxIps };
		await setCachedStats(kv, stats, numEnv(env, 'CACHE_TTL', CACHE_TTL, 0, 86400));
		return json(stats);
	},

	async getTaskStatus(kv, taskId) {
		const task = await getTask(kv, taskId);
		return task ? json(task) : err('任务不存在或已过期', 404);
	},

	async addIp(db, { ip, priority }, kv) {
		if (!ip) return err('IP不能为空');
		const { displayIp, port, name } = parseIP(ip);
		if (port === 'N/A' || !displayIp) return err('IP格式错误');

		let prio = priority;
		if (prio === undefined || prio === null) {
			const row = await db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 as n FROM ips').first();
			prio = row.n;
		}

		const { meta } = await db.prepare('INSERT OR IGNORE INTO ips(ip, name, active, priority) VALUES(?, ?, 1, ?)')
			.bind(`${displayIp}:${port}`, name || null, prio).run();

		if (meta.changes === 0) return err('IP已存在');
		await invalidateCache(kv);
		return json({ success: true });
	},

	async batchImport(db, { ips }, ctx, kv) {
		if (!Array.isArray(ips) || !ips.length) return err('列表为空');
		const taskId = crypto.randomUUID();
		ctx.waitUntil((async () => {
			try {
				const parsed = ips.map(ip => {
					const { displayIp, port, name } = parseIP(ip);
					return (port === 'N/A' || !displayIp) ? null : { ip: `${displayIp}:${port}`, name: name || null };
				}).filter(Boolean);
				if (parsed.length === 0) return await saveTask(kv, taskId, 'completed', '没有有效的IP地址');

				const row = await db.prepare('SELECT COALESCE(MAX(priority), 0) as p FROM ips').first();
				const stmt = db.prepare('INSERT OR IGNORE INTO ips(ip, name, active, priority) VALUES(?, ?, 1, ?)');
				const batch = parsed.map((item, i) => stmt.bind(item.ip, item.name, row.p + i + 1));

				// 修复（P2-7）：原提示按「提交条数」报数，重复项也被算进"成功导入"。
				// 现在汇总 INSERT OR IGNORE 的真实 changes，把重复/已存在条数如实报出。
				const results = await execBatches(db, batch);
				const inserted = results.reduce((n, r) => n + (Number(r && r.meta && r.meta.changes) || 0), 0);
				const skipped = parsed.length - inserted;
				await invalidateCache(kv);
				await saveTask(kv, taskId, 'completed',
					skipped > 0
						? `成功导入 ${inserted} 条数据，跳过重复/已存在 ${skipped} 条`
						: `成功导入 ${inserted} 条数据`);
			} catch (e) { await saveTask(kv, taskId, 'failed', e.message); }
		})());
		return json({ success: true, async: true, taskId, count: ips.length });
	},

	async batchDelete(db, { ips }, ctx, kv) {
		if (!Array.isArray(ips) || !ips.length) return err('列表为空');
		const taskId = crypto.randomUUID();
		ctx.waitUntil((async () => {
			try {
				const deleteIps = ips.map(line => {
					let targetIp = String(line).trim();
					if (targetIp.startsWith('vless://') || targetIp.startsWith('trojan://')) {
						try {
							const u = new URL(targetIp);
							return `${u.hostname}:${u.port || '443'}`;
						} catch { /* fallthrough */ }
					}
					if (targetIp.startsWith('vmess://')) {
						try {
							const config = JSON.parse(decodeBase64(normalizeBase64(targetIp.slice(8))));
							return `${config.add}:${config.port || '443'}`;
						} catch { /* fallthrough */ }
					}
					const { displayIp, port } = parseIP(targetIp);
					return (port === 'N/A' || !displayIp) ? null : `${displayIp}:${port}`;
				}).filter(Boolean);

				if (deleteIps.length === 0) return await saveTask(kv, taskId, 'completed', '没有识别到有效的节点或IP进行删除');

				const batch = deleteIps.map(ip => db.prepare('DELETE FROM ips WHERE ip=?').bind(ip));
				await execBatches(db, batch);
				await invalidateCache(kv);
				await saveTask(kv, taskId, 'completed', `成功清理了 ${deleteIps.length} 条匹配的数据`);
			} catch (e) { await saveTask(kv, taskId, 'failed', e.message); }
		})());
		return json({ success: true, async: true, taskId, count: ips.length });
	},

	async clearAll(db, ctx, kv) {
		const taskId = crypto.randomUUID();
		ctx.waitUntil((async () => {
			try {
				await db.prepare('DELETE FROM ips').run();
				await invalidateCache(kv);
				await saveTask(kv, taskId, 'completed', '清空完成');
			} catch (e) { await saveTask(kv, taskId, 'failed', e.message); }
		})());
		return json({ success: true, async: true, taskId });
	},

	async toggleAll(db, { active }, ctx, kv) {
		// 修复（P0-3）：GET 请求时 body 是 {}，active 为 undefined → 恒按「全部禁用」执行。
		// 这里显式要求布尔值，配合路由层的方法校验彻底堵住该路径。
		if (active !== true && active !== false && active !== 0 && active !== 1) return err('active 参数必须为 true/false');
		const taskId = crypto.randomUUID();
		ctx.waitUntil((async () => {
			try {
				await db.prepare('UPDATE ips SET active = ?').bind(active ? 1 : 0).run();
				await invalidateCache(kv);
				await saveTask(kv, taskId, 'completed', active ? '已全部启用' : '已全部禁用');
			} catch (e) { await saveTask(kv, taskId, 'failed', e.message); }
		})());
		return json({ success: true, async: true, taskId });
	},

	async updateIp(db, id, body, kv) {
		const { active, ip, priority } = body;
		const updates = [];
		if (ip !== undefined) {
			const { displayIp, port, name } = parseIP(ip);
			if (port === 'N/A' || !displayIp) return err('IP格式错误');
			updates.push(db.prepare('UPDATE ips SET ip=?, name=? WHERE id=?').bind(`${displayIp}:${port}`, name || null, id));
		}
		if (active !== undefined) updates.push(db.prepare('UPDATE ips SET active=? WHERE id=?').bind(active ? 1 : 0, id));
		if (priority !== undefined) updates.push(db.prepare('UPDATE ips SET priority = ? WHERE id = ?').bind(priority, id));
		if (updates.length > 0) { await db.batch(updates); await invalidateCache(kv); }
		return json({ success: true });
	},

	async deleteIp(db, id, kv) {
		await db.prepare('DELETE FROM ips WHERE id=?').bind(id).run();
		await invalidateCache(kv);
		return json({ success: true });
	},

	async sortIps(db, ctx, kv) {
		const taskId = crypto.randomUUID();
		ctx.waitUntil((async () => {
			try {
				// 修复：原实现一次性 SELECT 全表，大库会触及 D1 单次返回上限；改为分页遍历
				const results = await selectAllRows(db, 'SELECT id, ip, name, priority FROM ips ORDER BY id');
				const parsed = results.map(r => ({ ...r, region: extractRegion(r.name) }));
				parsed.sort((a, b) => getRegionIndex(a.region) - getRegionIndex(b.region)
					|| (Number(a.priority) || 0) - (Number(b.priority) || 0)
					|| a.id - b.id);
				await performIdReorder(db, parsed.map(s => s.id));
				await invalidateCache(kv);
				await saveTask(kv, taskId, 'completed', `排序完成，共 ${parsed.length} 条`);
			} catch (e) { await saveTask(kv, taskId, 'failed', e.message); }
		})());
		return json({ success: true, async: true, taskId });
	},

	async removeDuplicates(db, ctx, kv) {
		const taskId = crypto.randomUUID();
		ctx.waitUntil((async () => {
			try {
				// 修复（P0-2）：改为应用层按「IP 忽略端口」去重。
				// 原 SQL 用 SUBSTR(ip, 1, INSTR(ip, ':') - 1) 分组，IPv6（[::1]:443）分组键恒为 "["，
				// 会把所有 IPv6 判为同一 IP，一次清理就删到只剩一条。
				const rows = await selectAllRows(db, 'SELECT id, ip FROM ips ORDER BY id');
				const seen = new Set();
				const deleteIds = [];
				for (const row of rows) {
					const key = ipDedupKey(row.ip);
					if (seen.has(key)) deleteIds.push(row.id);
					else seen.add(key);
				}
				if (deleteIds.length === 0) {
					await saveTask(kv, taskId, 'completed', '没有发现重复数据');
					return;
				}
				const batch = deleteIds.map(id => db.prepare('DELETE FROM ips WHERE id = ?').bind(id));
				await execBatches(db, batch);
				await invalidateCache(kv);
				await saveTask(kv, taskId, 'completed', `清理了 ${deleteIds.length} 条重复数据`);
			} catch (e) { await saveTask(kv, taskId, 'failed', e.message); }
		})());
		return json({ success: true, async: true, taskId });
	},
};

// 生成短链（修复：原实现无鉴权、无 TTL、无碰撞检测、无来源限制）
async function createShortLink(kv, longUrl, env, request) {
	if (!kv) return err('未绑定 KV 空间', 500);
	if (!longUrl || typeof longUrl !== 'string') return err('链接不能为空');
	if (longUrl.length > SHORT_MAX_URL) return err('链接过长');

	// 修复（P2-17）：原实现只看字符串前缀，"/sub/../evil" 也能通过（规范化后指向 /evil）。
	// 现在先做 URL 规范化，再判断 pathname 是否真在 /sub 之下，并只存规范化后的路径。
	let parsed;
	try {
		parsed = new URL(longUrl, 'https://short.invalid');
	} catch {
		return err('链接格式错误');
	}
	const isUnderSub = parsed.pathname === SHORT_PREFIX || parsed.pathname.startsWith(`${SHORT_PREFIX}/`);
	if (!isUnderSub) return err(`链接必须以 ${SHORT_PREFIX} 开头`);

	if (env.SHORT_TOKEN) {
		const provided = parsed.searchParams.get('short_token');
		if (provided !== env.SHORT_TOKEN) return err('短链令牌校验失败', 403);
	}

	// 修复（P2-11）：未设 SHORT_TOKEN 时接口完全公开且无频率限制，可被刷 KV 写入。
	const clientIp = (request && request.headers.get('CF-Connecting-IP')) || 'unknown';
	const rateKey = `rl:short:${clientIp}`;
	const used = Number(await kv.get(rateKey)) || 0;
	if (used >= SHORT_RATE_LIMIT) return err('请求过于频繁，请稍后再试', 429);
	await kv.put(rateKey, String(used + 1), { expirationTtl: 60 }).catch(() => {});

	const normalizedUrl = parsed.pathname + parsed.search;

	for (let attempt = 0; attempt < 5; attempt++) {
		const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
		const existing = await kv.get(`short:${shortId}`);
		if (existing) continue; // 碰撞，重试
		await kv.put(`short:${shortId}`, normalizedUrl, { expirationTtl: numEnv(env, 'SHORT_TTL_DAYS', SHORT_TTL / 86400, 1, 365) * 24 * 3600 });
		return json({ success: true, shortId });
	}
	return err('短链生成失败，请重试', 500);
}

const handleApiRoute = async (req, db, ctx, kv, env) => {
	const url = new URL(req.url);
	const path = url.pathname.slice(4);
	const method = req.method;
	try {
		const body = (method === 'POST' || method === 'PUT') ? await req.json().catch(() => ({})) : {};

		// 修复：原实现写的是 `return api.xxx(...)`，返回的是 Promise 而非 await 结果，
		// 导致 api 内部抛错时不会被这里的 catch 捕获，而是变成未捕获异常（返回运行时 500 页
		// 而非约定的 JSON 错误体）。全部改为 await。
		//
		// 修复（P0-3）：原先只有 /ips、/ips/clear 校验了方法，其余写接口任何方法都会执行。
		// 浏览器会自动带上已登录的 Basic 凭据，于是 `GET /api/ips/toggle-all`（GET 时 body={}）
		// 会把全库 IP 禁用 —— 一个 <img src> 就能打挂全站订阅（CSRF）。现在一律校验方法。
		if (path === '/shorten' && method === 'POST') return await createShortLink(kv, body.longUrl, env, req);

		if (path === '/ips' && method === 'GET') return await api.getIps(db, url.searchParams, env);
		if (path === '/ips' && method === 'POST') return await api.addIp(db, body, kv);
		if (path === '/ips/stats' && method === 'GET') return await api.getStats(db, kv, env);
		if (path === '/ips/batch' && method === 'POST') return await api.batchImport(db, body, ctx, kv);
		if (path === '/ips/batch-delete' && method === 'POST') return await api.batchDelete(db, body, ctx, kv);
		if (path === '/ips/clear' && method === 'DELETE') return await api.clearAll(db, ctx, kv);
		if (path === '/ips/toggle-all' && method === 'POST') return await api.toggleAll(db, body, ctx, kv);
		if (path === '/ips/sort' && method === 'POST') return await api.sortIps(db, ctx, kv);
		if (path === '/ips/remove-duplicates' && method === 'POST') return await api.removeDuplicates(db, ctx, kv);
		if (path.startsWith('/task/') && method === 'GET') return await api.getTaskStatus(kv, path.slice(6));

		const idMatch = path.match(/^\/ips\/(\d+)$/);
		if (idMatch) {
			if (method === 'PUT') return await api.updateIp(db, idMatch[1], body, kv);
			if (method === 'DELETE') return await api.deleteIp(db, idMatch[1], kv);
		}
		return new Response('Not Found', { status: 404 });
	} catch (e) {
		return err(e.message, 500);
	}
};

// ============================================================================
// 10. 订阅核心流程
// ============================================================================
const isCsvUrl = (x) => /\.csv(?:[?#]|$)/i.test(x);
const isHttpUrl = (x) => /^https?:\/\//i.test(x);

// URL 级多源参数覆盖（add / addapi / addcsv / multi / dls）。
// 修复（P1-2）：原先只写在 loadIpRows 的 source=multi 分支里，生成器模式完全用不到，
// 同一个 /sub 入口出现「裂变能用、生成器静默忽略」的两套语义。现在抽成公共函数，
// 两条路径都调用；没有任何相关参数时为空操作。
function applyUrlSourceOverrides(rt) {
	const q = rt.url.searchParams;
	const urlAdd = splitList(q.get('add') || '');
	const urlAddApi = splitList(q.get('addapi') || '');
	const urlAddCsv = splitList(q.get('addcsv') || '');
	const urlDls = Number(q.get('dls'));

	// 自定义优选多行输入：一行一个来源，按内容自动分类
	//   .csv 结尾（或 .csv?xxx 带参数）→ 测速 CSV 源；http(s):// 开头 → 优选 API 源；其余 → 静态 ADD
	const mixed = splitList(q.get('multi') || '');
	const mixedStatic = mixed.filter(x => !isHttpUrl(x));
	const mixedHttp = mixed.filter(isHttpUrl);
	const mixedApi = mixedHttp.filter(x => !isCsvUrl(x));
	const mixedCsv = mixedHttp.filter(isCsvUrl);

	if (urlAdd.length || mixedStatic.length) rt.addList = urlAdd.length ? urlAdd : mixedStatic;
	if (urlAddApi.length || mixedApi.length) rt.addApiList = urlAddApi.length ? urlAddApi : mixedApi;
	if (urlAddCsv.length || mixedCsv.length) rt.addCsvList = urlAddCsv.length ? urlAddCsv : mixedCsv;

	// 与 buildRuntime 保持一致：ADD 里混入的 http(s) 链接自动分拣到 API / CSV 列表
	const httpInAdd = rt.addList.filter(isHttpUrl);
	if (httpInAdd.length) {
		rt.addList = rt.addList.filter(x => !isHttpUrl(x));
		rt.addApiList = rt.addApiList.concat(httpInAdd.filter(x => !isCsvUrl(x)));
		rt.addCsvList = rt.addCsvList.concat(httpInAdd.filter(isCsvUrl));
	}
	if (urlDls > 0) rt.dls = urlDls;
}

// 加载优选 IP 行：D1 私有库 / 外部库 / 多源
async function loadIpRows(env, rt) {
	const source = rt.url.searchParams.get('source');

	if (source === 'ext') {
		const extUrl = rt.url.searchParams.get('ext_url');
		if (!extUrl) throw new Error('缺少 ext_url 参数');
		const extRes = await fetch(extUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
		if (!extRes.ok) throw new Error(`HTTP状态码异常: ${extRes.status}`);
		const extText = await extRes.text();
		if (extText.trim().startsWith('<')) throw new Error('获取到的是网页而非纯文本列表，可能是链接失效或触发了防CC拦截');
		// 修复（P2-10）：外部库无条数上限与去重，几千行会被逐个套节点，有 CPU 超限风险。
		const seen = new Set();
		const rows = [];
		for (const line of extText.split('\n')) {
			const s = line.trim();
			if (!s || s.startsWith('#')) continue;
			const { displayIp, port, name } = parseIP(s);
			const ip = port === 'N/A' ? displayIp : `${displayIp}:${port}`;
			if (!ip || seen.has(ip)) continue;
			seen.add(ip);
			rows.push({ ip, name: name || '外网优选节点' });
			if (rows.length >= numEnv(env, 'MAX_EXT_IPS', MAX_EXT_IPS, 1, 5000)) break;
		}
		return rows;
	}

	if (source === 'multi') {
		applyUrlSourceOverrides(rt);
		const tlsAddresses = await collectAddresses(rt, true, env);
		return tlsAddresses.map(a => ({ ip: a, name: '' }));
	}

	const maxIps = numEnv(env, 'MAX_IPS', MAX_IPS, 1, 5000);
	const { results } = await env.DB.prepare('SELECT ip, name FROM ips WHERE active=1 ORDER BY priority, id LIMIT ?')
		.bind(maxIps).all();
	return results;
}

// 订阅令牌校验：/sub 与内置节点入口共用（修复 P1-1：内置入口原先不校验 SUB_TOKEN，
// 与 README「SUB_TOKEN 保护 /sub 与内置入口」不一致）。
const subTokenGuard = (rt, env) => {
	if (!env.SUB_TOKEN) return null;
	if (rt.url.searchParams.get('token') === env.SUB_TOKEN) return null;
	return textResponse(encodeBase64(createErrorNode('❌ Token 验证失败，请检查链接参数')), 200, { 'Cache-Control': 'no-cache' });
};

// UA 风控：命中屏蔽名单时返回伪装内容（nginx 假页 / 302 / 首页）
const uaBlockGuard = async (request, rt) => {
	if (rt.isSubConverterRequest || !rt.blockUA.length) return null;
	if (!rt.blockUA.some(u => u && rt.ua.includes(u))) return null;
	const camo = await handleCamouflage(request, rt);
	return camo || htmlResponse(getPublicHTML(rt));
};

async function handleSub(request, env, ctx, rt) {
	const url = rt.url;
	const base = url.searchParams.get('base');

	// Token 校验
	const tokenDenied = subTokenGuard(rt, env);
	if (tokenDenied) return tokenDenied;

	// UA 风控
	const uaDenied = await uaBlockGuard(request, rt);
	if (uaDenied) return uaDenied;

	// 修复：原实现用完整 URL 作为缓存键，但合并后输出会随 UA/target 变化，
	// 若仍按 URL 缓存会把 Clash 配置发给 base64 客户端。这里把输出变体并入缓存键。
	// 修复（P2-21）：后台增删改后，旧缓存最长还会返回 60s 的陈旧数据。
	// 现在把「数据版本号」也并入缓存键，后台每次写入都会自增，等价于即时失效。
	const target = resolveTarget(rt);
	const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
	const cacheUrl = new URL(url.toString());
	cacheUrl.searchParams.set('__v', target);
	if (env.TASK_KV) cacheUrl.searchParams.set('__dv', await getDataVersion(env.TASK_KV));
	const cacheKey = new Request(cacheUrl.toString(), request);
	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) return hit;
	}

	let nodeLinks;
	try {
		if (base) {
			// ---- 裂变模式 ----
			// 修复（P0-1）：先把 base 里的 uuid/host 解析进 rt，脱敏才有依据。
			// 原实现从不解析，导致 applyFake 的条件恒为假、真实凭据明文外发。
			const cred = extractBaseCredentials(base);
			if (cred.uuid) rt.uuid = cred.uuid;
			if (cred.host) rt.host = cred.host;
			const rows = await loadIpRows(env, rt);
			nodeLinks = rows.map(row => multiplexLink(base, row)).filter(Boolean).join('\n');
			if (!nodeLinks) nodeLinks = createErrorNode('❌ 没有生成任何可用节点(可能是基础节点格式不兼容或无优选IP)');
		} else {
			// ---- 生成器模式 ----
			resolveNodeParams(rt);
			// 修复（P1-2）：生成器模式同样支持 URL 级多源参数，与裂变模式语义一致。
			applyUrlSourceOverrides(rt);
			if (!rt.host || !rt.uuid) {
				const body = [
					'缺少必填参数：host 和 uuid',
					'Missing required parameters: host and uuid',
					'',
					`${url.origin}/sub?host=[your host]&uuid=[your uuid]&path=[your path]`,
					'',
					'https://github.com/cmliu/workerVless2sub',
				].join('\n');
				return textResponse(body, 202);
			}
			nodeLinks = await buildGeneratorLinks(rt, env);
			if (!nodeLinks) {
				// 修复（v1.2）：把「来源诊断」写进错误节点，别再让人对着
				// 「请检查优选源与节点参数」猜是哪一环空了。
				const detail = await describeGeneratorSources(rt, env);
				nodeLinks = createErrorNode(`❌ 没有生成任何可用节点｜来源：${detail}｜请确认源可达、私有库有启用的 IP`);
			}
		}
	} catch (e) {
		return textResponse(encodeBase64(createErrorNode(`❌ 订阅生成失败: ${e.message}`)), 200, { 'Cache-Control': 'no-cache' });
	}

	const res = await formatSubscription(nodeLinks, rt, request);
	if (cache && res.status === 200) {
		ctx.waitUntil(cache.put(cacheKey, res.clone()));
	}
	return res;
}

// 内置节点入口 /{TOKEN}
async function handleBuiltinEntry(request, env, ctx, rt) {
	// 修复（P1-1）：内置入口同样受 SUB_TOKEN 保护
	const tokenDenied = subTokenGuard(rt, env);
	if (tokenDenied) return tokenDenied;

	await resolveBuiltinParams(rt, env);
	if (!rt.path || !rt.path.trim()) rt.path = '/?ed=2560';
	else if (rt.path[0] !== '/') rt.path = '/' + rt.path;

	// 修复：原实现的 UA 风控位于 if/else 之后的公共段，内置入口同样生效；合并后此处曾丢失
	const uaDenied = await uaBlockGuard(request, rt);
	if (uaDenied) return uaDenied;

	ctx.waitUntil(sendTelegramNotice(
		env,
		`#获取订阅 ${rt.subName}`,
		request.headers.get('CF-Connecting-IP') || '',
		`UA: ${rt.uaHeader}\n域名: ${rt.url.hostname}\n入口: ${rt.url.pathname + rt.url.search}`
	));

	const nodeLinks = await buildGeneratorLinks(rt, env);
	if (!nodeLinks) return textResponse(encodeBase64(createErrorNode('❌ 没有生成任何可用节点(请检查内置节点参数与优选源)')), 200, { 'Cache-Control': 'no-cache' });
	return formatSubscription(nodeLinks, rt, request);
}

// ============================================================================
// 11. 前端页面
// ============================================================================
// --- 公开生成页：裂变模式（粘贴基础节点链接 + 选优选来源 → 生成短链） ---
const getPublicHTML = (rt) => {
	// 背景图：USER_CONFIG.background / env.IMG，多个则随机取一张
	const bg = rt.bgImages.length
		? `background-image: url('${rt.bgImages[Math.floor(Math.random() * rt.bgImages.length)]}');`
		: '';
	// 页脚署名：两项都留空时只剩版权年份
	const credit = [
		rt.tgGroup ? `支持: <a href="https://t.me/${rt.tgGroup}" target="_blank" class="tg-link">加入tg群组获取最新动态</a>` : '',
		rt.author ? `由 ${rt.author} 提供维护` : '',
	].filter(Boolean).join(' - ');
	const year = new Date().getFullYear();

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${rt.subName}</title>
${rt.ico}
<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
<style>
body { background-color: #1a1a2e; ${bg} background-size: cover; background-position: center; background-attachment: fixed; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: flex-start; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
.card { background: rgba(44, 44, 44, 0.1); backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px); padding: 40px; border-radius: 20px; width: 100%; max-width: 500px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); text-align: center; border: 1px solid rgba(255, 255, 255, 0.1); margin-left: 240px; }
.avatar { width: 80px; height: 80px; border-radius: 50%; background: #fff; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 40px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
h1 { font-size: 24px; margin-bottom: 40px; font-weight: 600; letter-spacing: 0.5px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); font-style: italic; }
.form-group { text-align: left; margin-bottom: 20px; }
label { display: block; font-size: 14px; margin-bottom: 8px; color: #eaeaea; font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
input, select { width: 100%; padding: 16px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; font-size: 14px; box-sizing: border-box; transition: all 0.3s ease; }
input:focus, select:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3); background: rgba(0, 0, 0, 0.6); }
input::placeholder { color: #aaa; }
select option { color: #000; background: #fff; }
button { width: 100%; padding: 16px; background: rgba(30, 58, 138, 0.85); color: #fff; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; transition: all 0.3s; margin-bottom: 15px; backdrop-filter: blur(5px); }
button:hover { background: rgba(29, 78, 216, 0.95); transform: translateY(-1px); }
button:disabled { opacity: 0.7; cursor: not-allowed; }
.footer { margin-top: 30px; font-size: 12px; color: #bbb; line-height: 1.6; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
.tg-link { color: #58a6ff; text-decoration: none; font-weight: bold; transition: color 0.2s; }
.tg-link:hover { color: #79c0ff; text-decoration: underline; }
#qrWrap { display: none; justify-content: center; margin-top: 25px; animation: fadeIn 0.5s ease; }
#qrCodeBox { background: #fff; padding: 15px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.4); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
.code-editor { display: flex; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; background: repeating-linear-gradient(to bottom, rgba(255,255,255,0.04) 0, rgba(255,255,255,0.04) 19.2px, transparent 19.2px, transparent 38.4px), rgba(0,0,0,0.4); background-position: 0 16px; resize: vertical; overflow: hidden; min-height: 154px; max-height: 60vh; }
.code-editor:focus-within { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.3); }
.code-gutter { flex: 0 0 34px; box-sizing: border-box; padding: 16px 8px 16px 0; text-align: right; font: 12px/19.2px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #777; user-select: none; white-space: pre; overflow: hidden; border-right: 1px solid rgba(255,255,255,0.06); }
.code-area { flex: 1; min-width: 0; box-sizing: border-box; border: none; border-radius: 0; background: transparent; padding: 16px; font: 12px/19.2px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #fff; resize: none; height: 100%; min-height: 120px; white-space: pre; overflow: auto; }
.code-area:focus { outline: none; box-shadow: none; background: transparent; }
.code-area::placeholder { color: #aaa; }
@media (max-width: 900px) {
	body { justify-content: center; padding: 12px; }
	.card { margin-left: 0; padding: 26px 18px; max-width: 100%; }
	h1 { font-size: 20px; margin-bottom: 26px; }
	.code-gutter { flex: 0 0 28px; }
}
@media (max-width: 420px) {
	.card { padding: 20px 14px; border-radius: 14px; }
	h1 { font-size: 18px; }
}
</style>
</head>
<body>
<div class="card">
    <div class="avatar">${rt.avatarUrl ? `<img src="${rt.avatarUrl}" alt="Logo">` : rt.avatarFallback}</div>
    <h1>${rt.subName}</h1>

    <div class="form-group">
        <label>基础节点链接</label>
        <input type="text" id="nodeLink" placeholder="请输入 VMess / VLESS / Trojan 链接" autocomplete="off">
    </div>

    <div class="form-group">
        <label>优选 IP 来源</label>
        <select id="ipSource" onchange="toggleExtInput()">
            <option value="local">本地私有优选库 (高稳定)</option>
            <option value="multi">多源优选 (ADD / ADDAPI / 测速CSV)</option>
            <option value="ext">外部公开优选库 (实时拉取)</option>
        </select>
    </div>

    <div class="form-group" id="extUrlGroup" style="display: none;">
        <label>外部优选库接口 (API 或 TXT)</label>
        <select id="extUrlSelect" onchange="document.getElementById('extUrl').value = this.value" style="margin-bottom: 8px;">
            <option value="https://cf.junzhen.qzz.io/best_ips_bj.txt">📶 动态测速 API - 电信优先</option>
            <option value="https://cf.junzhen.qzz.io/best_ips.txt">📶 动态测速 API - 联通优先</option>
            <option value="https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/best_ips.txt">📶 动态测速 API - 移动优先</option>
            <option value="https://bestcf.pages.dev/luoli/all.txt">🌐 动态测速 API - 通用官方</option>
            <option value="https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt">📦 静态 TXT 库 - cmliu (备用)</option>
            <option value="https://raw.githubusercontent.com/xiagefei/CFBestIP/refs/heads/main/addressesapi.txt">📦 红星优选库 (主力)</option>
            <option value="">✍️ 自定义：清空并手动输入链接...</option>
        </select>
        <input type="text" id="extUrl" placeholder="请选择上方接口或粘贴你的链接..." value="" autocomplete="off">
    </div>

    <div class="form-group" id="multiGroup" style="display: none;">
        <label>自定义优选 <span title="一行一个来源，自动识别类型：&#10;· 优选IP：104.16.2.3:443&#10;· 优选API：https://api.example.com/ct&#10;· 测速CSV：https://example.com/ips.csv" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,0.15);color:#bbb;font-size:11px;font-weight:normal;cursor:help;vertical-align:1px;">?</span></label>
        <div class="code-editor">
            <div class="code-gutter" id="multiGutter">1</div>
            <textarea id="multiSources" class="code-area" placeholder="https://raw.githubusercontent.com/xiegefei/CFBestIP/refs/heads/main/addressesapi.txt" spellcheck="false" autocomplete="off" oninput="syncMultiGutter()" onscroll="syncMultiGutter()"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:10px;">
            <label style="margin:0;white-space:nowrap;font-weight:normal;font-size:12px;color:#bbb;">DLS 测速阈值</label>
            <input type="number" id="multiDls" placeholder="可选，仅CSV源生效，留空用服务端默认" min="0" autocomplete="off" style="padding:10px 14px;font-size:13px;flex:0 0 160px;appearance:textfield;-webkit-appearance:textfield;margin:0;">
        </div>
    </div>

    <div class="form-group">
        <label>订阅输出格式</label>
        <select id="subFormat">
            <option value="">通用 Base64（默认）</option>
            <option value="clash">Clash / mihomo</option>
            <option value="singbox">sing-box</option>
            <option value="surge">Surge</option>
        </select>
    </div>

    <div class="form-group">
        <label>
            安全 Token (必填!)
            ${rt.tgChannel ? `<a href="https://t.me/${rt.tgChannel}" target="_blank" style="font-size: 12px; color: #58a6ff; font-weight: normal; margin-left: 8px; text-decoration: none;">(前往获取)</a>` : ''}
        </label>
        <input type="password" id="subToken" placeholder="请输入变量设置的subToken" autocomplete="off">
    </div>

    <button onclick="generateSub()" id="genBtn" style="margin-top:10px;">生成优选短链</button>

    <div class="form-group" style="margin-top: 20px;">
        <label>您的专属订阅 ❗</label>
        <input type="text" id="subResult" placeholder="点击生成后自动出现" readonly onclick="copyLink()">
    </div>

    <div id="qrWrap">
        <div id="qrCodeBox"></div>
    </div>

    <div class="footer">
        ${credit ? credit + ' ' : ''}&copy; ${year}
        <br><a href="/gen" class="tg-link">前往生成器模式</a> &nbsp;|&nbsp; <a href="/admin" class="tg-link">管理后台</a>
        ${rt.beian ? '<br>' + rt.beian : ''}
    </div>
</div>
<script>
function toggleExtInput() {
    const val = document.getElementById('ipSource').value;
    document.getElementById('extUrlGroup').style.display = val === 'ext' ? 'block' : 'none';
    const multiVisible = val === 'multi';
    document.getElementById('multiGroup').style.display = multiVisible ? 'block' : 'none';
    if (multiVisible) syncMultiGutter();
}

// 多行编辑器：左侧行号与文本域逐行对齐（行高固定 19.2px），并同步纵向滚动
function syncMultiGutter() {
    const ta = document.getElementById('multiSources');
    const gutter = document.getElementById('multiGutter');
    if (!ta || !gutter) return;
    const lines = ta.value.split('\\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\\n');
    gutter.scrollTop = ta.scrollTop;
}

async function generateSub() {
    const link = document.getElementById('nodeLink').value.trim();
    const token = document.getElementById('subToken').value.trim();
    const source = document.getElementById('ipSource').value;
    const extUrl = document.getElementById('extUrl').value.trim();
    const multiSources = document.getElementById('multiSources').value;
    const multiDls = document.getElementById('multiDls').value.trim();
    const fmt = document.getElementById('subFormat').value;

    if (!link) { alert('哎呀，你还没有填入节点链接哦！'); return; }
    if (source === 'ext' && !extUrl) { alert('请填写外部优选链接！'); return; }
    if (source === 'multi' && !multiSources.trim()) {
        if (!confirm('未填写任何自定义优选来源，将使用服务端默认多源配置（如有），确定继续？')) return;
    }

    const btn = document.getElementById('genBtn');
    btn.innerText = "生成中..."; btn.style.opacity = "0.7";
    btn.disabled = true;

    let subParams = '/sub?base=' + encodeURIComponent(link);
    if(token) subParams += '&token=' + encodeURIComponent(token);
    if(source === 'ext') subParams += '&source=ext&ext_url=' + encodeURIComponent(extUrl);
    if(source === 'multi') {
        subParams += '&source=multi';
        // 自定义优选：一行一个来源，换行/制表符归一为逗号；类型由服务端按内容自动识别
        const normMulti = s => s.split(/[\\r\\n\\t|]+/).map(x => x.trim()).filter(Boolean).join(',');
        const lines = normMulti(multiSources);
        if (lines) subParams += '&multi=' + encodeURIComponent(lines);
        if (multiDls) subParams += '&dls=' + encodeURIComponent(multiDls);
    }
    if(fmt) subParams += '&format=' + encodeURIComponent(fmt);

    let shortUrl = '';
    try {
        const res = await fetch('/api/shorten', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ longUrl: subParams })
        });
        const data = await res.json();

        if (data.success) {
            shortUrl = window.location.origin + '/s/' + data.shortId;
        } else {
            alert('生成短链失败: ' + (data.error || '未知错误'));
            shortUrl = window.location.origin + subParams;
        }
    } catch (e) {
        alert('网络请求失败，请检查控制台。');
        shortUrl = window.location.origin + subParams;
    } finally {
        btn.innerText = "生成优选短链";
        btn.style.opacity = "1";
        btn.disabled = false;
    }

    document.getElementById('subResult').value = shortUrl;
    renderQr(shortUrl);
}

// 修复（P2-20）：二维码库来自 CDN，加载失败不应被当成"网络请求失败"（原先 QRCode 抛错会落进
// 上面的 catch，弹出误导性提示）。这里独立渲染并静默降级。
function renderQr(text) {
    const qrWrap = document.getElementById('qrWrap');
    const qrCodeBox = document.getElementById('qrCodeBox');
    if (!qrWrap || !qrCodeBox) return;
    if (typeof QRCode === 'undefined') { qrWrap.style.display = 'none'; return; }
    try {
        qrCodeBox.innerHTML = '';
        new QRCode(qrCodeBox, {
            text: text, width: 180, height: 180,
            colorDark : "#000000", colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.M
        });
        qrWrap.style.display = 'flex';
    } catch (e) {
        qrWrap.style.display = 'none';
    }
}

function copyLink() {
    const res = document.getElementById('subResult');
    if (!res.value) return;
    const done = () => alert('✅ 订阅链接已复制！快去客户端添加吧。');
    // 修复：execCommand 已废弃，优先用 Clipboard API，失败再回退
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(res.value).then(done).catch(() => { res.select(); document.execCommand('copy'); done(); });
    } else {
        res.select();
        document.execCommand('copy');
        done();
    }
}
</script>
</body>
</html>`;
};

// --- 生成器页：粘贴节点链接 → 解析 host/uuid/path → 生成器模式订阅 ---
const getGeneratorHTML = (rt) => {
	const bg = rt.bgImages.length
		? `background-image: url('${rt.bgImages[Math.floor(Math.random() * rt.bgImages.length)]}');`
		: '';
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${rt.subName}</title>
	${rt.ico}
	<style>
		:root { --primary-color: #4361ee; --hover-color: #3b4fd3; --bg-color: #f5f6fa; --card-bg: #ffffff; }
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body { ${bg} background-size: cover; background-position: center; background-attachment: fixed; background-color: var(--bg-color); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
		.container { position: relative; background: rgba(255, 255, 255, 0.7); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); max-width: 600px; width: 90%; padding: 2rem; border-radius: 20px; box-shadow: 0 10px 20px rgba(0,0,0,0.05), inset 0 0 0 1px rgba(255, 255, 255, 0.1); }
		h1 { text-align: center; color: var(--primary-color); margin-bottom: 2rem; font-size: 1.8rem; }
		.input-group { margin-bottom: 1.5rem; }
		label { display: block; margin-bottom: 0.5rem; color: #555; font-weight: 500; }
		input, select { width: 100%; padding: 12px; border: 2px solid rgba(0, 0, 0, 0.15); border-radius: 10px; font-size: 1rem; background: #fff; color: #333; }
		input:focus, select:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.15); }
		button { width: 100%; padding: 12px; background-color: var(--primary-color); color: white; border: none; border-radius: 10px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-bottom: 1.5rem; }
		button:hover { background-color: var(--hover-color); }
		#result { background-color: #f8f9fa; font-family: monospace; word-break: break-all; }
		.logo-title { display: flex; justify-content: center; align-items: center; gap: 10px; margin-bottom: 2rem; }
		.logo-title img { width: 50px; height: 50px; border-radius: 50%; }
		.beian-info { text-align: center; font-size: 13px; margin-top: 12px; }
		.beian-info a { color: var(--primary-color); text-decoration: none; }
		#qrcode { display: flex; justify-content: center; align-items: center; margin-top: 20px; }
		.info-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background-color: var(--primary-color); color: white; font-size: 12px; margin-left: 8px; cursor: pointer; font-weight: bold; }
		.info-tooltip { display: none; position: fixed; background: white; border: 1px solid var(--primary-color); border-radius: 8px; padding: 15px; z-index: 1000; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 90vw; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 13px; }
	</style>
	<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
</head>
<body>
	<div class="container">
		<div class="logo-title">
			${rt.avatarUrl ? `<img src="${rt.avatarUrl}" alt="Logo">` : `<span style="font-size:40px;line-height:1;">${rt.avatarFallback}</span>`}
			<h1>${rt.subName}</h1>
		</div>
		<div class="input-group">
			<label for="link">节点链接</label>
			<input type="text" id="link" placeholder="请输入 VMess / VLESS / Trojan 链接">
		</div>

		<div class="input-group">
			<label for="ipSource">优选 IP 来源</label>
			<select id="ipSource" onchange="toggleGenSource()">
				<option value="">自动（环境变量多源优先，为空则用本地私有库）</option>
				<option value="local">仅用本地私有优选库（后台已启用的 IP）</option>
				<option value="multi">仅用环境变量多源（ADD / ADDAPI / 测速 CSV）</option>
				<option value="ext">外部公开优选库（实时拉取，需填下方地址）</option>
			</select>
		</div>

		<div class="input-group" id="extUrlGroup" style="display: none;">
			<label for="extUrl">外部优选库地址（API 或 TXT）</label>
			<input type="text" id="extUrl" placeholder="https://example.com/best_ips.txt" value="" autocomplete="off">
			<div style="font-size: 12px; color: #888; margin-top: 6px; line-height: 1.5;">
				一行一个 <code>IP:端口</code> 的纯文本列表；也可在首页「外部优选库接口」下拉里选好预设后复制链接过来。
			</div>
		</div>

		<div class="input-group">
			<label for="subToken">订阅 Token（若已启用 SUB_TOKEN）</label>
			<input type="password" id="subToken" placeholder="留空则不带 token 参数" autocomplete="off">
		</div>

		<button onclick="generateLink()">生成优选订阅</button>

		<div class="input-group">
			<div style="display: flex; align-items: center;">
				<label for="result">优选订阅</label>
				<span class="info-icon" onclick="toggleTooltip(event)">!</span>
				<div class="info-tooltip" id="infoTooltip">
					<strong>安全提示</strong>：使用优选订阅生成器时，需要您提交 <strong>节点配置信息</strong> 用于生成优选订阅链接。订阅器的维护者可能会获取到该节点信息。<strong>请自行斟酌使用风险。</strong><br><br>
					订阅转换后端：<strong>${rt.subProtocol}://${rt.subConverter}</strong>
				</div>
			</div>
			<input type="text" id="result" readonly onclick="copyToClipboard()">
			<label id="qrcode" style="margin: 15px 10px -15px 10px;"></label>
		</div>
		<div class="beian-info">${rt.beian}</div>
		<div class="beian-info"><a href="/">← 返回裂变生成页</a></div>
	</div>

	<script>
		function toggleTooltip(event) {
			event.stopPropagation();
			const tooltip = document.getElementById('infoTooltip');
			tooltip.style.display = tooltip.style.display === 'block' ? 'none' : 'block';
		}
		document.addEventListener('click', function(event) {
			const tooltip = document.getElementById('infoTooltip');
			const infoIcon = document.querySelector('.info-icon');
			if (infoIcon && !tooltip.contains(event.target) && !infoIcon.contains(event.target)) tooltip.style.display = 'none';
		});
		function copyToClipboard() {
			const resultInput = document.getElementById('result');
			if (!resultInput.value) return;
			resultInput.select();
			navigator.clipboard.writeText(resultInput.value).then(() => {
				const tip = document.createElement('div');
				tip.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);padding:8px 16px;background:#4361ee;color:white;border-radius:4px;z-index:1000';
				tip.textContent = '已复制到剪贴板';
				document.body.appendChild(tip);
				setTimeout(() => document.body.removeChild(tip), 2000);
			}).catch(() => alert('复制失败，请手动复制'));
		}
		// 修复：vmess:// 常用 URL-safe base64 且去掉 padding，直接 atob 会抛错
		function b64decode(s) {
			let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
			while (t.length % 4) t += '=';
			return decodeURIComponent(Array.prototype.map.call(atob(t), function (c) {
				return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
			}).join(''));
		}
		function renderQr(text) {
			const box = document.getElementById('qrcode');
			if (!box) return;
			if (typeof QRCode === 'undefined') { box.innerHTML = ''; return; }
			try {
				box.innerHTML = '';
				new QRCode(box, { text: text, width: 220, height: 220, colorDark: "#4a60ea", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.L, scale: 1 });
			} catch (e) { box.innerHTML = ''; }
		}
		function toggleGenSource() {
			const val = document.getElementById('ipSource').value;
			const group = document.getElementById('extUrlGroup');
			if (group) group.style.display = val === 'ext' ? 'block' : 'none';
		}
		function generateLink() {
			const link = document.getElementById('link').value.trim();
			if (!link) { alert('请输入节点链接'); return; }
			const origin = window.location.origin;
			let uuidType = 'uuid';
			if (link.startsWith('trojan://')) uuidType = 'password';
			let subLink = '';
			try {
				if (link.startsWith('vmess://')) {
					const vmessJson = JSON.parse(b64decode(link.slice(8)));
					const host = vmessJson.host || vmessJson.sni || vmessJson.add || '';
					const uuid = vmessJson.id || '';
					if (!host || !uuid) throw new Error('vmess 缺少 host/id');
					const path = vmessJson.path || '/';
					const sni = vmessJson.sni || host;
					const type = vmessJson.type || 'none';
					const alpn = vmessJson.alpn || '';
					const alterId = vmessJson.aid || 0;
					const security = vmessJson.scy || 'auto';
					subLink = origin + '/sub?host=' + encodeURIComponent(host) + '&uuid=' + encodeURIComponent(uuid)
						+ '&path=' + encodeURIComponent(path) + '&sni=' + encodeURIComponent(sni)
						+ '&type=' + encodeURIComponent(type) + '&alpn=' + encodeURIComponent(alpn)
						+ '&alterid=' + encodeURIComponent(alterId) + '&security=' + encodeURIComponent(security);
				} else {
					const rest = link.split('//')[1] || '';
					const uuid = rest.split('@')[0];
					const qs = link.split('?')[1];
					if (!uuid || !qs) throw new Error('链接缺少凭据或参数');
					subLink = origin + '/sub?' + uuidType + '=' + encodeURIComponent(uuid) + '&' + qs.split('#')[0];
				}
				const tokenEl = document.getElementById('subToken');
				const tk = tokenEl && tokenEl.value ? tokenEl.value.trim() : '';
				if (tk) subLink += '&token=' + encodeURIComponent(tk);
				const srcEl = document.getElementById('ipSource');
				const src = srcEl ? srcEl.value : '';
				if (src) subLink += '&source=' + encodeURIComponent(src);
				if (src === 'ext') {
					const extEl = document.getElementById('extUrl');
					const extUrl = extEl ? extEl.value.trim() : '';
					if (!extUrl) { alert('已选择外部公开优选库，请填写外部优选地址'); return; }
					if (!/^https?:\\/\\//i.test(extUrl)) { alert('外部优选地址需以 http:// 或 https:// 开头'); return; }
					subLink += '&ext_url=' + encodeURIComponent(extUrl);
				}
				document.getElementById('result').value = subLink;
				renderQr(subLink);
			} catch (error) {
				alert('链接格式错误，请检查输入');
			}
		}
	</script>
</body>
</html>`;
};

// --- 管理后台 ---
const getAdminHTML = () => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>优选 IP 管理后台</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--fg:#e6edf3;--fg2:#b3bac4;--fg3:#8b949e;--border:#30363d;--blue:#58a6ff;--green:#3fb950;--red:#f85149;--purple:#a371f7;--orange:#db6d28;--radius:12px;}
*{margin:0;padding:0;box-sizing:border-box}
body{font:15px/1.6 sans-serif;background:var(--bg);color:var(--fg);min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:30px 24px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px}
h1{font-size:32px;background:linear-gradient(135deg,var(--blue),var(--purple));-webkit-background-clip:text;color:transparent; margin:0;}
.back-btn { color: var(--blue); text-decoration: none; font-weight: bold; }
.section{background:var(--bg2);border-radius:var(--radius);padding:24px;margin-bottom:24px;border:1px solid var(--border)}
h2{font-size:18px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
h2::before{content:'';width:4px;height:16px;background:var(--blue);border-radius:2px}
.stats{display:flex;gap:16px;margin-bottom:24px}
.stat{flex:1;background:var(--bg3);padding:20px;border-radius:var(--radius);text-align:center;border:1px solid var(--border)}
.stat-num{font-size:28px;font-weight:bold;color:var(--blue)}
input,textarea{width:100%;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);margin-bottom:16px}
input:focus,textarea:focus{outline:none;border-color:var(--blue);}
button{background:var(--blue);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:bold;margin-right:8px;margin-bottom:8px;transition: opacity 0.2s;}
button:hover{opacity: 0.8;}
button:disabled{opacity: 0.5; cursor: not-allowed;}
button.danger{background:var(--red)}
button.sec{background:var(--bg3);color:var(--fg)}
button.page-btn{padding:8px 14px; margin:0;}
button.page-btn.active{background:var(--blue); color:#fff; cursor:default; opacity:1;}
.ip-list{list-style:none;}
.ip-item{display:flex;justify-content:space-between;align-items:center;padding:16px;background:var(--bg3);border:1px solid var(--border);margin-bottom:8px;border-radius:8px; flex-wrap: wrap; gap: 10px;}
.ip-address { font-family:monospace; font-size:16px; color:var(--fg); word-break: break-all; }
.ip-meta{font-size:13px;color:var(--fg2);margin-top:4px}
.tag{background:rgba(88,166,255,0.1);color:var(--blue);padding:2px 8px;border-radius:4px;font-size:12px;margin-right:6px}
.action-buttons{display: flex; gap: 8px; flex-wrap: wrap; align-items: center;}
.status-text.active { color: var(--green); }
.status-text.inactive { color: var(--red); }
.search-box { display:flex; gap:8px; margin-bottom:20px; flex-wrap:wrap; }
.search-box input { margin-bottom:0; flex:1; min-width:200px; }
.page-badge { color:var(--fg2); font-size:14px; background:var(--bg3); padding:6px 14px; border-radius:20px; border:1px solid var(--border); }

@media (max-width: 768px) {
    .container { padding: 15px 12px; }
    .header { flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 20px; }
    .ip-item { flex-direction: column; align-items: flex-start; }
    .action-buttons button, .search-box button { width: 100%; margin-right: 0; }
    .action-buttons { flex-direction: column; width: 100%; }
    #pagination { gap: 4px; }
    .page-btn { padding: 6px 10px; }
}
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>优选 IP 库管理</h1>
        <a href="/" class="back-btn">&larr; 返回首页</a>
    </div>

    <div class="stats">
        <div class="stat"><div class="stat-num" id="total">-</div><div>总优选IP</div></div>
        <div class="stat"><div class="stat-num" id="active">-</div><div>活跃中</div></div>
        <div class="stat"><div class="stat-num" id="cap">-</div><div>订阅取用上限</div></div>
    </div>
    <div style="color:var(--fg2);font-size:13px;margin:-10px 0 20px;">订阅只会取用「启用中」里权重最高的前 N 条，超出部分不参与生成；活跃数超过上限时上面的数字会变红。</div>

    <div class="section">
        <h2>批量添加 / 删除指定 IP</h2>
        <textarea id="batchIps" rows="5" placeholder="格式: IP:端口#国家 (例如 104.16.2.3:443#美国)&#10;每行一个。删除指定IP时只需粘贴要删的IP或完整节点链接即可。"></textarea>
        <div class="action-buttons">
            <button onclick="batchImport()">批量导入</button>
            <button class="danger" onclick="batchDelete()">删除指定IP</button>
            <button class="danger" style="background:#8b0000;" onclick="clearAll()">清空全部数据</button>
        </div>
    </div>

    <div class="section">
        <h2>操作面板与搜索</h2>
        <div class="search-box">
            <input id="searchInput" placeholder="无需回车，输入内容自动搜索...">
            <button class="sec" style="margin-bottom:0;" onclick="clearSearch()">显示全部</button>
        </div>
        <div class="action-buttons" style="flex-direction:row;">
            <button class="sec" onclick="sortIps()">按地区排序</button>
            <button class="sec" onclick="removeDuplicates()">清理重复IP</button>
            <button class="sec" style="color:var(--green)" onclick="toggleAll(1)">全部启用</button>
            <button class="sec" style="color:var(--red)" onclick="toggleAll(0)">全部禁用</button>
        </div>
        <div id="msg" style="color:var(--green);margin-top:10px;font-weight:bold"></div>
    </div>

    <div class="section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:10px;">
            <h2 style="margin:0;">IP 列表</h2>
            <div class="page-badge">第 <strong id="page" style="color:var(--blue)">1</strong> 页 / 共 <strong id="totalPages" style="color:var(--blue)">1</strong> 页</div>
        </div>
        <div class="ip-list" id="list">加载中...</div>
        <div id="pagination" style="margin-top:24px; display:flex; justify-content:center; gap:8px; flex-wrap:wrap; align-items:center;"></div>
    </div>
</div>

<div id="editModal" style="display:none; position:fixed; inset:0; background:rgba(13,17,23,0.8); align-items:center; justify-content:center; z-index:1000; padding:20px; backdrop-filter:blur(4px);">
    <div style="background:var(--bg2); border-radius:var(--radius); padding:24px; width:100%; max-width:400px; border:1px solid var(--border); box-shadow: 0 4px 24px rgba(0,0,0,0.5);">
        <h2 style="margin-top:0; color:var(--fg); font-size:20px;">编辑节点信息</h2>
        <input id="editId" type="hidden">

        <label style="display:block; font-size:13px; color:var(--fg2); margin-bottom:6px;">IP 和 端口</label>
        <input id="editIp" placeholder="例如 104.16.2.3:443" style="margin-bottom:16px;">

        <label style="display:block; font-size:13px; color:var(--fg2); margin-bottom:6px;">备注名称</label>
        <input id="editName" placeholder="例如 香港优选 (选填)" style="margin-bottom:16px;">

        <label style="display:block; font-size:13px; color:var(--fg2); margin-bottom:6px;">排序权重 (越小越靠前，置顶可填 0 或 -1)</label>
        <input id="editPriority" type="number" placeholder="数字越小越靠前" style="margin-bottom:8px;">

        <div style="display:flex; gap:10px; margin-top:20px;">
            <button style="flex:1;" onclick="saveEdit()">保存修改</button>
            <button style="flex:1;" class="sec" onclick="closeEdit()">取消</button>
        </div>
    </div>
</div>

<script>
let page = 1;
let totalPages = 1;
let currentKeyword = '';
let searchTimeout = null;
let currentRows = [];

const $ = id => document.getElementById(id);
const msg = t => { $('msg').innerText = t; setTimeout(() => $('msg').innerText='', 3000) };
const api = async (p, o={}) => { const r = await fetch('/api'+p, {headers:{'Content-Type':'application/json'}, ...o}); return r.json(); };
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

$('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { currentKeyword = e.target.value.trim(); page = 1; load(); }, 500);
});

const clearSearch = () => { $('searchInput').value = ''; currentKeyword = ''; page = 1; load(); };

const load = async () => {
    const query = new URLSearchParams({ page, needTotal: 'true' });
    if (currentKeyword) query.append('keyword', currentKeyword);

    const fail = (text) => {
        // 修复（P2-16）：原实现不判错，接口 401/500 时 res.ips 为 undefined，
        // 整页停在"加载中..."且不给出任何原因。
        $('list').innerHTML = '<div style="text-align:center; color:var(--fg2); padding:30px;">' + esc(text) + '</div>';
        $('pagination').innerHTML = '';
    };

    let stats, res;
    try {
        [stats, res] = await Promise.all([api('/ips/stats'), api('/ips?' + query.toString())]);
    } catch (e) {
        fail('加载失败：' + (e && e.message ? e.message : '网络错误'));
        return;
    }
    if (!stats || !res || stats.error || res.error || !Array.isArray(res.ips)) {
        fail('加载失败：' + ((stats && stats.error) || (res && res.error) || '接口返回异常'));
        return;
    }

    $('total').innerText = stats.total; $('active').innerText = stats.active;
    if (stats.limit) {
        $('cap').innerText = stats.limit;
        $('cap').style.color = (stats.active > stats.limit) ? 'var(--red)' : '';
    }
    totalPages = (res.pagination && res.pagination.pages) || 1;
    $('page').innerText = page; $('totalPages').innerText = totalPages;

    currentRows = res.ips;
    $('list').innerHTML = res.ips.map((ip, i) => \`
        <li class="ip-item">
            <div>
                <div class="ip-address">\${esc(ip.displayIp)}:\${esc(ip.port)}</div>
                <div class="ip-meta">
                    \${ip.name ? '<span class="tag">'+esc(ip.name)+'</span>' : ''}
                    状态: <span class="status-text \${ip.active ? 'active' : 'inactive'}">\${ip.active?'启用中':'已禁用'}</span>
                </div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; width:100%; justify-content: flex-end;">
                <button class="sec" onclick="openEditAt(\${i})">编辑</button>
                <button class="sec" onclick="toggleIpAt(\${i})">\${ip.active?'禁用':'启用'}</button>
                <button class="danger" onclick="delAt(\${i})">删除</button>
            </div>
        </li>
    \`).join('') || '<div style="text-align:center; color:var(--fg2); padding:30px;">'+(currentKeyword?'没有搜索到匹配的节点':'暂无数据')+'</div>';

    renderPagination();
};

const renderPagination = () => {
    let html = \`<button class="sec page-btn" \${page === 1 ? 'disabled' : \`onclick="goToPage(\${page-1})"\`}>上一页</button>\`;
    let start = Math.max(1, page - 2);
    let end = Math.min(totalPages, page + 2);
    if (start > 1) {
        html += \`<button class="sec page-btn" onclick="goToPage(1)">1</button>\`;
        if (start > 2) html += \`<span style="color:var(--fg2); padding:0 4px;">...</span>\`;
    }
    for (let i = start; i <= end; i++) {
        if (i === page) html += \`<button class="page-btn active">\${i}</button>\`;
        else html += \`<button class="sec page-btn" onclick="goToPage(\${i})">\${i}</button>\`;
    }
    if (end < totalPages) {
        if (end < totalPages - 1) html += \`<span style="color:var(--fg2); padding:0 4px;">...</span>\`;
        html += \`<button class="sec page-btn" onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
    }
    html += \`<button class="sec page-btn" \${page === totalPages ? 'disabled' : \`onclick="goToPage(\${page+1})"\`}>下一页</button>\`;
    $('pagination').innerHTML = html;
};

const goToPage = (p) => { page = p; load(); };

// 修复（P1-4）：原实现只在 status 为 completed/failed 时 clearInterval。
// 任务过期（TTL 300s）或未绑定 KV 时 /api/task 返回 404 -> {error}，
// res.status 永远是 undefined，于是每秒永久轮询。现在加了错误分支与硬超时。
const poll = (id, cb) => {
    let tries = 0;
    let done = false;
    const finish = (text) => {
        if (done) return;
        done = true;
        clearInterval(t);
        if (text) msg(text);
        cb();
    };
    const t = setInterval(async () => {
        tries += 1;
        if (tries > 60) { finish('任务状态查询超时，已停止轮询'); return; }
        let res;
        try {
            res = await api('/task/' + id);
        } catch (e) {
            finish('任务状态查询失败：' + (e && e.message ? e.message : '网络错误'));
            return;
        }
        if (!res || res.error) { finish('任务状态不可用：' + ((res && res.error) || '未知错误')); return; }
        if (res.status === 'completed' || res.status === 'failed') finish(res.message || '任务完成');
    }, 1000);
};

const toggleIp = async (id, currentStatus) => {
    const res = await api('/ips/'+id, {method:'PUT', body:JSON.stringify({active: currentStatus ? 0 : 1})});
    if (res && res.error) { msg('操作失败：' + res.error); return; }
    load();
};
const toggleIpAt = (i) => { const ip = currentRows[i]; if (ip) toggleIp(ip.id, ip.active); };
const delAt = (i) => { const ip = currentRows[i]; if (ip) del(ip.id); };
const openEditAt = (i) => {
    const ip = currentRows[i];
    if (!ip) return;
    $('editId').value = ip.id;
    $('editIp').value = ip.displayIp + ':' + ip.port;
    $('editName').value = ip.name || '';
    $('editPriority').value = ip.priority || 0;
    $('editModal').style.display = 'flex';
};
const closeEdit = () => { $('editModal').style.display = 'none'; };
const saveEdit = async () => {
    const id = $('editId').value;
    const ipStr = $('editIp').value.trim();
    const nameStr = $('editName').value.trim();
    const priorityVal = parseInt($('editPriority').value);

    if(!ipStr) return msg('IP不能为空');
    let fullIP = ipStr; if(nameStr) fullIP += '#' + nameStr;

    const updateBody = { ip: fullIP };
    if (!isNaN(priorityVal)) updateBody.priority = priorityVal;

    try {
        const res = await api('/ips/'+id, {method:'PUT', body:JSON.stringify(updateBody)});
        if (res.error) { msg('修改失败: ' + res.error); return; }
        msg('修改成功');
        closeEdit();
        load();
    } catch(e) {
        msg('修改失败，格式错误');
    }
};
const del = async (id) => { if(confirm('确定要彻底删除此IP吗？')) { await api('/ips/'+id, {method:'DELETE'}); load(); } };

const toggleAll = async (active) => { if(!confirm(active ? '确定将所有节点设为启用吗？' : '确定将所有节点设为禁用吗？')) return; const res = await api('/ips/toggle-all', {method:'POST', body:JSON.stringify({active})}); msg('操作执行中...'); poll(res.taskId, load); };
const batchImport = async () => { const ips = $('batchIps').value.split('\\n').filter(Boolean); if(!ips.length) { msg('请先在输入框填写 IP'); return; } const res = await api('/ips/batch', {method:'POST', body:JSON.stringify({ips})}); msg('导入任务已启动...'); $('batchIps').value = ''; poll(res.taskId, load); };
const batchDelete = async () => { const ips = $('batchIps').value.split('\\n').filter(Boolean); if(!ips.length) { msg('请先在输入框填写要删除的 IP 或节点链接'); return; } if(!confirm('确定要删除上面填写的节点对应的 IP 吗？')) return; const res = await api('/ips/batch-delete', {method:'POST', body:JSON.stringify({ips})}); msg('批量删除任务已启动...'); $('batchIps').value = ''; poll(res.taskId, load); };
const clearAll = async () => { if(!confirm('警告：确定清空所有优选IP吗？此操作不可逆！')) return; const res = await api('/ips/clear', {method:'DELETE'}); msg('清空任务启动...'); poll(res.taskId, () => { page=1; load(); }); };
const sortIps = async () => { const res = await api('/ips/sort', {method:'POST'}); msg('排序中...'); poll(res.taskId, load); };
const removeDuplicates = async () => { const res = await api('/ips/remove-duplicates', {method:'POST'}); msg('去重中...'); poll(res.taskId, load); };

$('editModal').onclick = (e) => { if(e.target === $('editModal')) closeEdit(); };
load();
</script>
</body>
</html>`;

// ============================================================================
// 12. 主路由
// ============================================================================
const checkAuth = (req, env) => {
	// 密码不做 trim：允许密码本身含空格（如 "my pass word"），空串视为未设置。
	const expected = env.ADMIN_PASSWORD || env.ADMIN_PASS || '';
	if (!expected) return true;

	// 用户名默认可填任意值（保持旧行为，避免升级后把已登录的用户锁在门外）；
	// 只有显式配置 ADMIN_USER 时才校验用户名。
	const expectedUser = pickEnv(env, 'ADMIN_USER', 'ADMINUSER');

	const authHeader = req.headers.get('Authorization');
	if (!authHeader) return false;

	const [scheme, encoded] = authHeader.split(' ');
	if (scheme !== 'Basic' || !encoded) return false;

	try {
		const decoded = atob(encoded);
		const idx = decoded.indexOf(':'); // 修复：原实现用 split(':')，密码含冒号时会被截断
		const user = idx >= 0 ? decoded.slice(0, idx) : '';
		const password = idx >= 0 ? decoded.slice(idx + 1) : '';
		if (password !== expected) return false;
		return expectedUser ? user === expectedUser : true;
	} catch {
		return false;
	}
};

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		// --- 短链跳转（公开） ---
		if (path.startsWith('/s/')) {
			const shortId = path.slice(3);
			if (env.TASK_KV && shortId) {
				const longUrl = await env.TASK_KV.get(`short:${shortId}`);
				if (longUrl) return Response.redirect(new URL(longUrl, url.origin).toString(), 302);
			}
			return textResponse('❌ 短链接无效或已过期', 404);
		}

		// --- 安全拦截区 ---
		if (path === '/admin' || path.startsWith('/api/')) {
			// /api/shorten 走自己的令牌校验（见 createShortLink），其余接口要 Basic Auth
			if (path !== '/api/shorten' && !checkAuth(request, env)) {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="Admin Access Requires Password"' },
				});
			}
		}

		// 修复：不依赖运行时配置的路由先处理，避免每个后台 API 请求（含每秒一次的任务
		// 轮询）都白跑一遍 buildRuntime（哈希 + 出网拉取）。
		if (path === '/admin') return htmlResponse(getAdminHTML());
		if (path.startsWith('/api/')) return handleApiRoute(request, env.DB, ctx, env.TASK_KV, env);

		// --- 以下路由需要请求级运行时 ---
		const rt = await buildRuntime(env, request);

		if (path === '/') return htmlResponse(getPublicHTML(rt));
		if (path === '/gen') return htmlResponse(getGeneratorHTML(rt));

		// --- 内置节点入口 /{TOKEN} ---
		if (rt.entryTokens.some(t => t && path === `/${t}`)) {
			return handleBuiltinEntry(request, env, ctx, rt);
		}

		// --- 统一订阅入口 ---
		// 修复（P2-1）：原先只认 `/sub`，客户端填成 `/sub/`（或复制时多带斜杠）会回落到首页，
		// 拿到的是 HTML 而不是订阅。这里把尾斜杠归一。
		if (path === '/sub' || path === '/sub/') return handleSub(request, env, ctx, rt);

		// --- 伪装 ---
		const camo = await handleCamouflage(request, rt);
		if (camo) return camo;

		return htmlResponse(getPublicHTML(rt));
	},
};
