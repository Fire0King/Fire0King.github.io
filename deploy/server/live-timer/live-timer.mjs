#!/usr/bin/env node
/**
 * B 站直播「礼物加时」计时器 · 服务端
 *
 * 干三件事：
 *   1. 用 WebSocket 连 B 站直播弹幕流，监听送礼物 / 大航海 / SC；
 *   2. 维护一个"结束时间戳"（deadline），礼物按配置折算成分钟数往上加；
 *   3. 每秒把状态写成一份 JSON（默认 <站点根>/api/live-timer.json），
 *      前端页面轮询它就够了 —— 和同目录 live-status-poller 是同一套思路，同源、无 CORS。
 *
 * 为什么不用 SSE/常驻连接给前端：静态站点上轮询一份几百字节的 JSON 最省事，
 * 断线、刷新、OBS 重启全都天然自愈。想更低延迟可以反代到本进程的 /state。
 *
 * 零依赖：只用 Node 内置模块（node:22+ 自带全局 fetch / WebSocket / brotli）。
 *   启动：node live-timer.mjs --config ./live-timer.config.json
 *   自检：node live-timer.mjs --config ./live-timer.config.json --check
 *   演示：node live-timer.mjs --demo        # 不连 B 站，只跑计时 + 假礼物，用来调样式
 */

import {
	createHash,
	createHmac,
	randomBytes,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import {
	brotliCompressSync,
	brotliDecompressSync,
	deflateSync,
	inflateSync,
} from "node:zlib";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ 基础工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
	const t = new Date().toLocaleString("zh-CN", { hour12: false });
	console.log(`[${t}]`, ...args);
}

function die(msg) {
	console.error(`❌ ${msg}`);
	process.exit(1);
}

function clamp(value, min, max) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

async function readJson(file) {
	try {
		// 去掉可能的 BOM：在 Windows 上用记事本/某些编辑器保存的配置会带
		const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
		return JSON.parse(text);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

async function writeJsonAtomic(file, data) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data)}\n`, "utf8");
	await rename(tmp, file);
}

/* ------------------------------------------------------------------ 口令与会话 */

/**
 * 网页端改配置的鉴权：
 *   - 口令只存 scrypt 哈希（不存明文，也不可逆推）；
 *   - 登录成功后发一个 HMAC 签名的令牌（8 小时），之后每次请求带 Bearer 令牌；
 *   - 连续错 5 次锁 5 分钟，避免被爆破。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
		N: SCRYPT.N,
		r: SCRYPT.r,
		p: SCRYPT.p,
	});
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
	try {
		const [scheme, n, r, p, saltB64, hashB64] = String(stored).split("$");
		if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
		const salt = Buffer.from(saltB64, "base64");
		const expected = Buffer.from(hashB64, "base64");
		if (expected.length === 0) return false;
		const actual = scryptSync(String(password), salt, expected.length, {
			N: Number(n),
			r: Number(r),
			p: Number(p),
			maxmem: 64 * 1024 * 1024,
		});
		return (
			actual.length === expected.length && timingSafeEqual(actual, expected)
		);
	} catch {
		return false;
	}
}

function signSession(secret, expMs) {
	const payload = `${expMs}.${randomBytes(9).toString("base64url")}`;
	const sig = createHmac("sha256", secret).update(payload).digest("base64url");
	return { token: `${payload}.${sig}`, exp: expMs };
}

function verifySession(secret, token) {
	const parts = String(token ?? "").split(".");
	if (parts.length !== 3) return null;
	const [expStr, nonce, sig] = parts;
	const expected = createHmac("sha256", secret)
		.update(`${expStr}.${nonce}`)
		.digest();
	let given;
	try {
		given = Buffer.from(sig, "base64url");
	} catch {
		return null;
	}
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return null;
	}
	const exp = Number(expStr);
	if (!Number.isFinite(exp) || exp < Date.now()) return null;
	return { exp };
}

/* ------------------------------------------------------------------ 可在线编辑的配置 */

function pickEditable(config) {
	return {
		roomId: config.roomId,
		initialMinutes: config.initialMinutes,
		cnyToMinutes: config.cnyToMinutes,
		ignoreSilverGifts: config.ignoreSilverGifts,
		gifts: { ...config.gifts },
		guards: {
			1: Number(config.guards[1]) || 0,
			2: Number(config.guards[2]) || 0,
			3: Number(config.guards[3]) || 0,
		},
		caps: { ...config.caps },
	};
}

/** 只做白名单字段的校验 + 夹紧，绝不接受 outFile / stateFile / adminToken 这类字段 */
function normalizeEditable(raw) {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "配置不是对象" };
	}
	const roomId = Math.round(Number(raw.roomId));
	// 注意：B 站真实房间号经常超过 10 亿（比如 1750753391），上限别写太小
	if (!Number.isFinite(roomId) || roomId <= 0 || roomId > 1e12) {
		return { ok: false, error: "直播间号不合法（应为正整数）" };
	}
	const gifts = {};
	const rawGifts = raw.gifts && typeof raw.gifts === "object" ? raw.gifts : {};
	let count = 0;
	for (const [key, value] of Object.entries(rawGifts)) {
		const name = String(key).trim();
		const hasControlChar = [...name].some((ch) => ch.charCodeAt(0) < 32);
		if (!name || name.length > 40 || hasControlChar) continue;
		const minutes = Number(value);
		if (!Number.isFinite(minutes) || minutes < 0) continue;
		gifts[name] = Math.round(Math.min(1440, minutes) * 10) / 10;
		count += 1;
		if (count >= 60) break;
	}
	const guardOf = (level) => {
		const n = Number(raw.guards?.[level]);
		return Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.round(n))) : 0;
	};
	const capOf = (key, max) => {
		const n = Number(raw.caps?.[key]);
		return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;
	};
	return {
		ok: true,
		value: {
			roomId,
			initialMinutes: Math.min(
				1440,
				Math.max(1, Math.round(Number(raw.initialMinutes) || 120)),
			),
			cnyToMinutes: Math.min(600, Math.max(0, Number(raw.cnyToMinutes) || 0)),
			ignoreSilverGifts: raw.ignoreSilverGifts !== false,
			gifts,
			guards: { 1: guardOf(1), 2: guardOf(2), 3: guardOf(3) },
			caps: {
				perGiftMinutes: capOf("perGiftMinutes", 1440),
				perUserPerMinute: capOf("perUserPerMinute", 1440),
				totalMinutes: capOf("totalMinutes", 10080),
			},
		},
	};
}

/* ------------------------------------------------------------------ 配置 */

const DEFAULT_CONFIG = {
	/** 直播间号（短号/长号都行，会自动换成真实房间号） */
	roomId: 0,
	/** 控制接口监听地址：只监听本机，由 nginx 反代出去；要从别的机器访问改 0.0.0.0 */
	host: "127.0.0.1",
	port: 8848,
	/** 控制接口口令，留空则只允许 127.0.0.1 调用 */
	adminToken: "",
	/**
	 * 网页端登录用的口令与签名密钥（只有哈希和随机密钥，不存明文）。
	 * 放在 /var/lib/live-timer（服务以 www-data 运行，网页上改口令时能原子写入）；
	 * 由 `node live-timer.mjs --set-password` 初始化。
	 */
	adminFile: "/var/lib/live-timer/admin.json",
	/** 状态输出的 JSON 路径 */
	outFile: "/var/www/site/api/live-timer.json",
	/** 进程重启后恢复计时用的状态文件 */
	stateFile: "/var/lib/live-timer/state.json",
	/** 可选：SESSDATA 等 cookie，用于拿到部分只在登录态下推送的礼物事件 */
	cookie: "",
	/** 初始时长（分钟） */
	initialMinutes: 120,
	/** 启动时是否处于暂停 */
	paused: false,
	/** 免费礼物（银瓜子/小心心、辣条之类）是否计入 */
	ignoreSilverGifts: true,
	/** 没在 gifts 表里命中的礼物：1 元 = 多少分钟 */
	cnyToMinutes: 1,
	/** 礼物 price 字段的单位：金瓜子 → 元，除以这个数（B 站是 1000） */
	priceUnit: 1000,
	/** 指定礼物的固定时长，键可以是 giftId 或礼物名 */
	gifts: {},
	/** 大航海：guard_level → 分钟 */
	guards: { 1: 30, 2: 60, 3: 120 },
	/** 上限保护，防止一场直播被加到天亮 */
	caps: {
		/** 单次礼物最多折算多少分钟 */
		perGiftMinutes: 60,
		/** 同一用户 60 秒内最多加多少分钟（0 = 不限） */
		perUserPerMinute: 10,
		/** 整场累计最多加多少分钟（0 = 不限） */
		totalMinutes: 480,
	},
};

function loadConfig(raw) {
	const config = {
		...DEFAULT_CONFIG,
		...raw,
		caps: { ...DEFAULT_CONFIG.caps, ...(raw?.caps ?? {}) },
		guards: { ...DEFAULT_CONFIG.guards, ...(raw?.guards ?? {}) },
		gifts: { ...(raw?.gifts ?? {}) },
	};
	if (!config.roomId) die("配置里缺少 roomId（直播间号）");
	if (!config.outFile) die("配置里缺少 outFile（状态 JSON 的输出路径）");
	config.port = clamp(Number(config.port) || 8848, 1, 65535);
	return config;
}

/* ------------------------------------------------------------------ 计时状态 */

/**
 * 状态只存"绝对时间"，不存"剩余秒数"：
 * 进程重启、页面刷新、OBS 重开都不会让倒计时漂移，这是断点续计的前提。
 */
class TimerState {
	constructor(config) {
		this.config = config;
		this.initialMs = Math.round(config.initialMinutes * 60_000);
		this.deadline = Date.now() + this.initialMs;
		this.startedAt = Date.now();
		this.paused = Boolean(config.paused);
		this.pausedRemainingMs = this.initialMs;
		this.addedMs = 0;
		this.removedMs = 0;
		this.giftCount = 0;
		this.lastGift = null;
		this.recent = [];
		/** 每个用户最近一分钟加了多少毫秒：uid → { windowStart, ms } */
		this.userBudget = new Map();
		/** 去重：最近 60 秒见过的礼物签名 */
		this.seen = new Map();
	}

	static async load(config, file) {
		const state = new TimerState(config);
		const saved = await readJson(file);
		if (saved?.version !== 1) return state;
		state.initialMs = Number(saved.initialMs) || state.initialMs;
		state.deadline = Number(saved.deadline) || state.deadline;
		state.startedAt = Number(saved.startedAt) || state.startedAt;
		state.paused = Boolean(saved.paused);
		state.pausedRemainingMs = Number(saved.pausedRemainingMs) || 0;
		state.addedMs = Number(saved.addedMs) || 0;
		state.removedMs = Number(saved.removedMs) || 0;
		state.giftCount = Number(saved.giftCount) || 0;
		state.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 8) : [];
		state.lastGift = saved.lastGift ?? null;
		return state;
	}

	toPersist() {
		return {
			version: 1,
			initialMs: this.initialMs,
			deadline: this.deadline,
			startedAt: this.startedAt,
			paused: this.paused,
			pausedRemainingMs: this.pausedRemainingMs,
			addedMs: this.addedMs,
			removedMs: this.removedMs,
			giftCount: this.giftCount,
			lastGift: this.lastGift,
			recent: this.recent,
		};
	}

	remainingMs(now = Date.now()) {
		if (this.paused) return Math.max(0, this.pausedRemainingMs);
		return this.deadline - now;
	}

	pause() {
		if (this.paused) return;
		this.pausedRemainingMs = Math.max(0, this.deadline - Date.now());
		this.paused = true;
	}

	resume() {
		if (!this.paused) return;
		this.deadline = Date.now() + this.pausedRemainingMs;
		this.paused = false;
	}

	/** 整场重新开始（换场直播时用）；开局时长按「当前配置」算，改配置后点重开就生效 */
	start() {
		const now = Date.now();
		const initialMs = Math.round(Number(this.config.initialMinutes) * 60_000);
		if (Number.isFinite(initialMs) && initialMs > 0) this.initialMs = initialMs;
		this.deadline = now + this.initialMs;
		this.startedAt = now;
		this.paused = false;
		this.pausedRemainingMs = this.initialMs;
		this.addedMs = 0;
		this.removedMs = 0;
		this.giftCount = 0;
		this.lastGift = null;
		this.recent = [];
		this.userBudget.clear();
	}

	/** 加减时长，返回实际生效的毫秒数（可能被上限截断） */
	shift(ms) {
		if (this.paused) {
			this.pausedRemainingMs = Math.max(0, this.pausedRemainingMs + ms);
		} else if (ms >= 0) {
			this.deadline += ms;
		} else {
			this.deadline = Math.max(Date.now(), this.deadline + ms);
		}
		if (ms >= 0) this.addedMs += ms;
		else this.removedMs += -ms;
		return ms;
	}

	/** 剩余可加额度（毫秒），受 caps.totalMinutes 与 perGift/perUser 约束 */
	remainingTotalBudgetMs() {
		const cap = this.config.caps.totalMinutes;
		if (!cap) return Number.POSITIVE_INFINITY;
		return Math.max(0, cap * 60_000 - this.addedMs);
	}

	userBudgetLeftMs(uid) {
		const cap = this.config.caps.perUserPerMinute;
		if (!cap) return Number.POSITIVE_INFINITY;
		const now = Date.now();
		const entry = this.userBudget.get(uid);
		if (!entry || now - entry.windowStart > 60_000) {
			this.userBudget.set(uid, { windowStart: now, ms: 0 });
			return cap * 60_000;
		}
		return Math.max(0, cap * 60_000 - entry.ms);
	}

	spendUserBudget(uid, ms) {
		const entry = this.userBudget.get(uid);
		if (entry) entry.ms += ms;
	}

	/** 返回 true 表示这条是重复投递，应当忽略 */
	seenRecently(signature) {
		const now = Date.now();
		for (const [key, at] of this.seen) {
			if (now - at > 60_000) this.seen.delete(key);
		}
		if (this.seen.has(signature)) return true;
		this.seen.set(signature, now);
		return false;
	}

	snapshot(extra = {}) {
		const now = Date.now();
		const remaining = this.remainingMs(now);
		return {
			v: 1,
			now,
			updatedAt: new Date(now).toISOString(),
			roomId: this.config.roomId,
			roomUrl: `https://live.bilibili.com/${this.config.roomId}`,
			startedAt: this.startedAt,
			deadline: this.deadline,
			paused: this.paused,
			pausedRemainingMs: this.pausedRemainingMs,
			remainingMs: remaining,
			initialMs: this.initialMs,
			addedMs: this.addedMs,
			removedMs: this.removedMs,
			giftCount: this.giftCount,
			lastGift: this.lastGift,
			recent: this.recent,
			...extra,
		};
	}
}

/* ------------------------------------------------------------------ 礼物折算 */

function numberFrom(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** 把一条礼物事件折算成毫秒；返回 0 表示不计入 */
function giftToMs(config, data) {
	const giftId = String(data.giftId ?? "");
	const name = String(data.giftName ?? "");
	const coinType = String(data.coin_type ?? "");
	const num = Math.max(1, numberFrom(data.num) || 1);

	if (config.ignoreSilverGifts && coinType === "silver") return 0;

	const rule = config.gifts[giftId] ?? config.gifts[name];
	if (rule !== undefined) {
		const minutes = typeof rule === "number" ? rule : numberFrom(rule.minutes);
		return Math.round(minutes * 60_000) * (rule.perUnit === true ? num : 1);
	}

	const cny =
		coinType === "gold" ? (numberFrom(data.price) / config.priceUnit) * num : 0;
	if (cny <= 0) return 0;
	return Math.round(cny * config.cnyToMinutes * 60_000);
}

function guardToMs(config, data) {
	const level = numberFrom(data.guard_level);
	const num = Math.max(1, numberFrom(data.num) || 1);
	const minutes = numberFrom(config.guards[level]);
	return Math.round(minutes * 60_000) * num;
}

function superChatToMs(config, data) {
	const cny = numberFrom(data.price);
	if (cny <= 0) return 0;
	return Math.round(cny * config.cnyToMinutes * 60_000);
}

/* ------------------------------------------------------------------ 弹幕协议 */

const OP = {
	HEARTBEAT: 2,
	HEARTBEAT_REPLY: 3,
	NOTIFY: 5,
	AUTH: 7,
	AUTH_REPLY: 8,
};

/**
 * getDanmuInfo 现在要 wbi 签名，否则一律 -352（风控），跟 IP 没关系。
 * 取 nav 接口的 img_key + sub_key，按这张表打乱后取 32 位当口令。
 */
const WBI_INDEX_TABLE = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];
const WBI_TTL = 11 * 60 * 60 * 1000;

function encodeFrame(body, op, protover = 1) {
	const buf = Buffer.alloc(16 + body.length);
	buf.writeUInt32BE(16 + body.length, 0);
	buf.writeUInt16BE(16, 4);
	buf.writeUInt16BE(protover, 6);
	buf.writeUInt32BE(op, 8);
	buf.writeUInt32BE(1, 12);
	body.copy(buf, 16);
	return buf;
}

const buildPacket = (body, op) => encodeFrame(body, op, 1);

/** 按 16 字节头切成一个个包；protover 2/3 的包体是压缩过的，要递归再解 */
function* unpackFrames(buffer) {
	let offset = 0;
	while (offset + 16 <= buffer.length) {
		const total = buffer.readUInt32BE(offset);
		const headerLen = buffer.readUInt16BE(offset + 4);
		const protover = buffer.readUInt16BE(offset + 6);
		const op = buffer.readUInt32BE(offset + 8);
		if (total < headerLen || offset + total > buffer.length) return;
		yield {
			protover,
			op,
			body: buffer.subarray(offset + headerLen, offset + total),
		};
		offset += total;
	}
}

class DanmakuClient {
	constructor(config, onCommand, onStatus) {
		this.config = config;
		this.onCommand = onCommand;
		this.onStatus = onStatus;
		this.stopped = false;
		this.ws = null;
		this.buvid = "";
		this.wbiKey = "";
		this.wbiAt = 0;
	}

	headers(roomId) {
		const cookie = [`buvid3=${this.buvid}`];
		if (this.config.cookie)
			cookie.push(this.config.cookie.replace(/^;\s*/, ""));
		return {
			"User-Agent": UA,
			Referer: `https://live.bilibili.com/${roomId}`,
			Cookie: cookie.filter(Boolean).join("; "),
		};
	}

	async ensureBuvid() {
		if (this.buvid) return;
		try {
			const res = await fetch(
				"https://api.bilibili.com/x/frontend/finger/spi",
				{
					headers: { "User-Agent": UA },
				},
			);
			const json = await res.json();
			this.buvid = json?.data?.b_3 ?? "";
		} catch {
			// 拿不到就算了，多数直播间不带 buvid 也能连上
		}
	}

	async resolveRoom() {
		await this.ensureBuvid();
		try {
			const res = await fetch(
				`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.config.roomId}`,
				{ headers: this.headers(this.config.roomId) },
			);
			const json = await res.json();
			const data = json?.data;
			if (json?.code === 0 && data?.room_id) {
				this.roomId = Number(data.room_id);
				this.liveStatus = Number(data.live_status) || 0;
				return;
			}
		} catch {
			// 拉不到房间信息不影响连弹幕
		}
		this.roomId = this.config.roomId;
	}

	/** wbi 口令：11 小时刷新一次就够（B 站自己也是这个量级） */
	async wbiKeyValue() {
		const now = Date.now();
		if (this.wbiKey && now - this.wbiAt < WBI_TTL) return this.wbiKey;
		const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
			headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
		});
		const json = await res.json();
		const imgUrl = json?.data?.wbi_img?.img_url ?? "";
		const subUrl = json?.data?.wbi_img?.sub_url ?? "";
		const fileName = (url) => url.split("/").pop()?.split(".")[0] ?? "";
		const shuffled = fileName(imgUrl) + fileName(subUrl);
		if (shuffled.length < 64)
			throw new Error("nav 接口没返回 wbi_img，拿不到签名 key");
		this.wbiKey = WBI_INDEX_TABLE.map((i) => shuffled[i]).join("");
		this.wbiAt = now;
		return this.wbiKey;
	}

	async signedQuery(params) {
		const key = await this.wbiKeyValue();
		const wts = String(Math.round(Date.now() / 1000));
		const all = { ...params, wts };
		const query = Object.keys(all)
			.sort()
			.map(
				(k) =>
					`${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`,
			)
			.join("&");
		const wRid = createHash("md5")
			.update(query + key)
			.digest("hex");
		return `${query}&w_rid=${wRid}`;
	}

	/** getDanmuInfo：拿 token 和弹幕服务器地址 */
	async getToken() {
		await this.ensureBuvid();
		const roomId = this.roomId ?? this.config.roomId;
		let lastError = "";
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const query = await this.signedQuery({ id: roomId, type: 0 });
			const res = await fetch(
				`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
				{ headers: this.headers(roomId) },
			);
			const json = await res.json();
			if (json?.code === 0 && json?.data?.token) {
				const hosts = (json.data.host_list ?? [])
					.map((h) => h.host)
					.filter(Boolean);
				return { token: json.data.token, hosts };
			}
			lastError = `code=${json?.code} message=${json?.message ?? "?"}`;
			if (json?.code === -352) {
				// 签名过期或被打回，清掉缓存重签一次
				this.wbiKey = "";
				this.wbiAt = 0;
				continue;
			}
			break;
		}
		throw new Error(
			`getDanmuInfo 失败 ${lastError}（-352 一般是签名/IP 被风控：在配置里填 cookie，或换台机器/网络试试）`,
		);
	}

	stop() {
		this.stopped = true;
		try {
			this.ws?.close();
		} catch {
			// ignore
		}
	}

	async run() {
		await this.resolveRoom();
		let backoff = 1000;
		while (!this.stopped) {
			try {
				const { token, hosts } = await this.getToken();
				await this.connectOnce(token, hosts);
				if (this.stopped) return;
				this.onStatus?.({ connected: false, reason: "连接关闭" });
				backoff = 1000;
			} catch (err) {
				this.onStatus?.({ connected: false, reason: err.message });
				log(
					`⚠️ 弹幕连接失败：${err.message}，${Math.round(backoff / 1000)} 秒后重试`,
				);
			}
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 30_000);
		}
	}

	connectOnce(token, hosts) {
		return new Promise((resolvePromise) => {
			const host =
				hosts[Math.floor(Math.random() * hosts.length)] ??
				"broadcastlv.chat.bilibili.com";
			const ws = new WebSocket(`wss://${host}/sub`);
			this.ws = ws;
			try {
				ws.binaryType = "arraybuffer";
			} catch {
				// 部分实现不支持，下面按 Blob 兜底
			}
			let heartbeat = null;
			const finish = (reason) => {
				clearInterval(heartbeat);
				if (this.ws === ws) this.ws = null;
				this.onStatus?.({ connected: false, reason });
				resolvePromise();
			};

			ws.addEventListener("open", () => {
				const auth = Buffer.from(
					JSON.stringify({
						uid: 0,
						roomid: this.roomId ?? this.config.roomId,
						protover: 3,
						platform: "web",
						type: 2,
						key: token,
					}),
				);
				ws.send(buildPacket(auth, OP.AUTH));
				heartbeat = setInterval(() => {
					try {
						ws.send(buildPacket(Buffer.alloc(0), OP.HEARTBEAT));
					} catch {
						// 连接已断，等 close 事件收尾
					}
				}, 30_000);
			});

			ws.addEventListener("message", async (event) => {
				let buffer;
				if (event.data instanceof ArrayBuffer) {
					buffer = Buffer.from(event.data);
				} else if (typeof event.data === "string") {
					buffer = Buffer.from(event.data);
				} else if (event.data?.arrayBuffer) {
					buffer = Buffer.from(await event.data.arrayBuffer());
				} else {
					return;
				}
				this.handleBuffer(buffer);
			});

			ws.addEventListener("close", () => finish("服务端关闭连接"));
			ws.addEventListener("error", () => finish("连接错误"));
		});
	}

	handleBuffer(buffer) {
		for (const frame of unpackFrames(buffer)) {
			if (frame.protover === 2) {
				this.handleBuffer(inflateSync(frame.body));
			} else if (frame.protover === 3) {
				this.handleBuffer(brotliDecompressSync(frame.body));
			} else if (frame.op === OP.NOTIFY) {
				try {
					this.onCommand(JSON.parse(frame.body.toString("utf8")));
				} catch {
					// 单条解析失败忽略，不要影响整条流
				}
			} else if (frame.op === OP.AUTH_REPLY) {
				let code = 0;
				try {
					code = JSON.parse(frame.body.toString("utf8") || "{}")?.code ?? 0;
				} catch {
					// ignore
				}
				if (code === 0) {
					log(`✅ 已连上直播间 ${this.roomId ?? this.config.roomId} 的弹幕流`);
					this.onStatus?.({ connected: true });
				} else {
					this.onStatus?.({
						connected: false,
						reason: `鉴权失败 code=${code}`,
					});
				}
			}
		}
	}
}

/* ------------------------------------------------------------------ 自检 */

/**
 * 不连网的离线自检：验证协议解包、礼物折算、计时与上限。
 * B 站改协议或你改配置之后先跑一遍，比直播间里翻车强。
 */
async function selfTest(config) {
	let pass = 0;
	const failures = [];
	const check = (name, ok, detail = "") => {
		if (ok) {
			pass += 1;
			console.log(`  ✅ ${name}`);
		} else {
			failures.push(name);
			console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ""}`);
		}
	};

	console.log("1) 弹幕协议解包（明文 / zlib / brotli）");
	const giftCmd = {
		cmd: "SEND_GIFT",
		data: {
			uid: 42,
			uname: "测试观众",
			giftId: 31036,
			giftName: "小花花",
			num: 1,
			price: 1000,
			coin_type: "gold",
			timestamp: 1700000000000,
			combo_num: 1,
		},
	};
	const giftBody = Buffer.from(JSON.stringify(giftCmd));
	const plain = encodeFrame(giftBody, OP.NOTIFY, 0);
	const frames = [
		plain,
		encodeFrame(deflateSync(plain), OP.NOTIFY, 2),
		encodeFrame(brotliCompressSync(plain), OP.NOTIFY, 3),
	];
	const received = [];
	const client = new DanmakuClient(
		config,
		(cmd) => received.push(cmd),
		() => {},
	);
	for (const frame of frames) client.handleBuffer(frame);
	check(
		"三种压缩格式都能解出同一条 SEND_GIFT",
		received.length === 3 &&
			received.every((c) => c.cmd === "SEND_GIFT" && c.data.giftId === 31036),
		`解出 ${received.length} 条`,
	);

	let authed = false;
	const authClient = new DanmakuClient(
		config,
		() => {},
		(status) => {
			if (status.connected) authed = true;
		},
	);
	authClient.handleBuffer(
		encodeFrame(Buffer.from(JSON.stringify({ code: 0 })), OP.AUTH_REPLY, 0),
	);
	check("鉴权回包能识别成已连接", authed);

	console.log("2) 礼物折算");
	const baseGift = { coin_type: "gold", price: 1000, num: 1 };
	check(
		`1 元礼物 = ${config.cnyToMinutes} 分钟`,
		giftToMs(config, { ...baseGift, timestamp: 1 }) ===
			config.cnyToMinutes * 60_000,
	);
	check(
		"数量 ×2 翻倍",
		giftToMs(config, { ...baseGift, num: 2 }) === config.cnyToMinutes * 120_000,
	);
	check(
		config.ignoreSilverGifts
			? "银瓜子（免费）礼物默认不计"
			: "银瓜子礼物按配置处理",
		config.ignoreSilverGifts
			? giftToMs(config, { coin_type: "silver", price: 0, num: 1 }) === 0
			: true,
	);
	const overrideCfg = { ...config, gifts: { 小花花: 2 } };
	check(
		"按礼物名覆盖成 2 分钟",
		giftToMs(overrideCfg, { ...baseGift, giftName: "小花花" }) === 120_000,
	);
	check(
		"大航海舰长按 guards 折算",
		guardToMs(config, { guard_level: 1, num: 1 }) === config.guards[1] * 60_000,
	);
	check(
		"SC 30 元 = 30 分钟",
		superChatToMs(config, { price: 30 }) === 30 * config.cnyToMinutes * 60_000,
	);

	console.log("3) 计时状态机");
	const capsCfg = {
		...config,
		initialMinutes: 60,
		caps: { perGiftMinutes: 1, perUserPerMinute: 2, totalMinutes: 3 },
	};
	const timer = new TimerState(capsCfg);
	check("开局剩余约 60 分钟", Math.abs(timer.remainingMs() - 3_600_000) < 2000);
	timer.shift(90_000);
	check(
		"加 90 秒后剩余约 61.5 分钟",
		Math.abs(timer.remainingMs() - 3_690_000) < 2000,
	);
	timer.pause();
	const frozen = timer.remainingMs();
	await sleep(1100);
	check(
		"暂停后剩余不再减少",
		timer.remainingMs() === frozen,
		`${frozen} → ${timer.remainingMs()}`,
	);
	timer.resume();
	check("继续后从暂停点接着走", Math.abs(timer.remainingMs() - frozen) < 2000);
	const cfgCap = capsCfg.caps;
	check(
		"单人额度 = perUserPerMinute",
		timer.userBudgetLeftMs(7) === cfgCap.perUserPerMinute * 60_000,
	);
	timer.spendUserBudget(7, 60_000);
	check(
		"花掉一分钟后额度减少",
		timer.userBudgetLeftMs(7) === (cfgCap.perUserPerMinute - 1) * 60_000,
	);
	check(
		"整场额度 = totalMinutes - 已加时",
		timer.remainingTotalBudgetMs() ===
			cfgCap.totalMinutes * 60_000 - timer.addedMs,
	);
	check(
		"同一礼物签名第二次被识别为重复",
		!timer.seenRecently("x") && timer.seenRecently("x"),
	);

	console.log("4) 网页配置校验");
	const okRoom = normalizeEditable({
		roomId: 1750753391,
		initialMinutes: 120,
		cnyToMinutes: 1,
		gifts: {},
		guards: {},
		caps: {},
	});
	check("真实房间号（>10 亿）能通过校验", okRoom.ok === true);
	check(
		"非法房间号被拒",
		normalizeEditable({ roomId: 0, gifts: {}, guards: {}, caps: {} }).ok ===
			false,
	);
	const trimmed = normalizeEditable({
		roomId: 1,
		gifts: { 小花花: 2.55, "": 9, 辣条: -1 },
		guards: {},
		caps: {},
	});
	check(
		"礼物表被裁剪（负数丢弃、小数保留一位）",
		trimmed.ok === true &&
			trimmed.value.gifts["小花花"] === 2.6 &&
			!("辣条" in trimmed.value.gifts) &&
			!("" in trimmed.value.gifts),
	);

	console.log(
		`\n${failures.length === 0 ? "✅" : "❌"} 自检结束：通过 ${pass} 项` +
			(failures.length
				? `，失败 ${failures.length} 项（${failures.join("、")}）`
				: ""),
	);
	if (failures.length) process.exit(1);
}

/* ------------------------------------------------------------------ 主程序 */

async function main() {
	const argv = process.argv.slice(2);
	const flag = (name) => argv.includes(name);
	const argValue = (name, fallback) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
	};

	if (flag("--help") || flag("-h")) {
		console.log(`用法: node live-timer.mjs [--config 配置路径] [--set-password [口令]] [--check] [--self-test] [--demo]

  --config <path>        配置文件（默认 ./live-timer.config.json，可用 LIVE_TIMER_CONFIG 覆盖）
  --set-password [口令]   设置/重置网页登录口令（不给口令就随机生成并打印）
  --check                只验证能否拿到弹幕服务器地址，然后退出
  --self-test            离线自检：协议解包 / 礼物折算 / 计时与上限
  --demo                 不连 B 站，跑一个假计时器（调 OBS 样式用），礼物用 POST /control 模拟`);
		return;
	}

	if (typeof WebSocket === "undefined") {
		die(`需要 Node 22 及以上（内置 WebSocket）。当前版本：${process.version}`);
	}

	const configPath = argValue(
		"--config",
		process.env.LIVE_TIMER_CONFIG ?? "./live-timer.config.json",
	);
	const configFilePath = resolve(configPath);
	const raw = await readJson(configFilePath);
	if (!raw) die(`读不到配置文件：${configFilePath}`);
	const config = loadConfig(raw);

	// 设置网页登录口令：node live-timer.mjs --set-password [口令]
	// 不给口令就随机生成一个并打印；只存 scrypt 哈希，不存明文
	if (flag("--set-password")) {
		const idx = argv.indexOf("--set-password");
		const next = argv[idx + 1];
		const given =
			next && !next.startsWith("--")
				? next
				: (process.env.LIVE_TIMER_ADMIN_PASSWORD ?? "");
		const password =
			String(given).trim().length >= 6
				? String(given).trim()
				: randomBytes(9).toString("base64url");
		const adminPath = resolve(config.adminFile);
		await writeJsonAtomic(adminPath, {
			passwordHash: hashPassword(password),
			sessionSecret: randomBytes(32).toString("base64"),
			updatedAt: new Date().toISOString(),
		});
		await chmod(adminPath, 0o640).catch(() => {});
		console.log(`✅ 网页登录口令：${password}`);
		console.log(`   文件：${adminPath}（建议 chown root:www-data，权限 0640）`);
		console.log("   不用重启服务，下一次登录立刻生效。");
		if (String(given).trim().length > 0 && String(given).trim().length < 6) {
			console.log("   ⚠️ 你给的口令太短（< 6 位），已改用随机口令。");
		}
		return;
	}

	if (flag("--self-test")) {
		await selfTest(config);
		return;
	}

	if (flag("--check")) {
		const client = new DanmakuClient(
			config,
			() => {},
			() => {},
		);
		await client.resolveRoom();
		const { hosts, token } = await client.getToken();
		console.log(
			`✅ 房间 ${client.roomId}（直播状态 ${client.liveStatus ?? "?"}，1=直播中）`,
		);
		console.log(
			`✅ 拿到 ${hosts.length} 个弹幕服务器：${hosts.slice(0, 3).join(", ")}`,
		);
		console.log(`✅ token 长度 ${token.length}，配置可用`);
		return;
	}

	const demo = flag("--demo");
	const statePath = resolve(config.stateFile);
	const outPath = resolve(config.outFile);

	const state = demo
		? new TimerState(config)
		: await TimerState.load(config, statePath);
	const runtime = {
		connected: demo,
		reason: demo ? "demo" : "启动中",
		liveStatus: null,
	};

	/* ---------- 礼物事件 → 加时 ---------- */

	function grant(ms, meta) {
		if (ms <= 0) return 0;
		const perGiftCap = config.caps.perGiftMinutes * 60_000;
		let applied = Math.min(ms, perGiftCap || Number.POSITIVE_INFINITY);
		applied = Math.min(applied, state.remainingTotalBudgetMs());
		if (applied <= 0) return 0;
		state.shift(applied);
		state.giftCount += 1;
		const event = { ...meta, deltaMs: applied, at: Date.now() };
		state.lastGift = event;
		state.recent = [event, ...state.recent].slice(0, 6);
		log(
			`🎁 ${meta.user} 送出 ${meta.label}，+${(applied / 60_000).toFixed(2)} 分钟`,
		);
		return applied;
	}

	function onCommand(cmd) {
		const data = cmd?.data ?? {};
		switch (cmd?.cmd) {
			case "SEND_GIFT": {
				const signature = `${data.uid}:${data.giftId}:${data.timestamp}:${data.combo_num ?? ""}:${data.num}`;
				if (state.seenRecently(signature)) return;
				let ms = giftToMs(config, data);
				if (ms <= 0) return;
				const userLeft = state.userBudgetLeftMs(data.uid);
				if (userLeft <= 0) {
					log(`⏳ ${data.uname} 触发单人限速，本次礼物不加时`);
					return;
				}
				ms = Math.min(ms, userLeft);
				const applied = grant(ms, {
					kind: "gift",
					user: String(data.uname ?? "观众"),
					uid: Number(data.uid) || 0,
					label: `${data.giftName ?? "礼物"}${Number(data.num) > 1 ? ` ×${data.num}` : ""}`,
					giftId: String(data.giftId ?? ""),
				});
				if (applied) state.spendUserBudget(data.uid, applied);
				return;
			}
			case "GUARD_BUY": {
				const ms = guardToMs(config, data);
				if (ms > 0) {
					grant(ms, {
						kind: "guard",
						user: String(data.username ?? "观众"),
						uid: Number(data.uid) || 0,
						label: `${data.gift_name ?? "大航海"}（${["", "总督", "提督", "舰长"][Number(data.guard_level)] ?? "大航海"}）`,
					});
				}
				return;
			}
			case "SUPER_CHAT_MESSAGE": {
				const ms = superChatToMs(config, data);
				if (ms > 0) {
					grant(ms, {
						kind: "superchat",
						user: String(data.user_info?.uname ?? "观众"),
						uid: Number(data.uid) || 0,
						label: `醒目留言 ¥${numberFrom(data.price)}`,
					});
				}
				return;
			}
			default:
				return;
		}
	}

	/* ---------- 控制接口 ---------- */

	const json = (res, code, payload) => {
		const body = JSON.stringify(payload);
		res.writeHead(code, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"Access-Control-Allow-Origin": "*",
		});
		res.end(body);
	};

	function authorized(req) {
		if (!config.adminToken) {
			const addr = req.socket.remoteAddress ?? "";
			return (
				addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
			);
		}
		return req.headers["x-timer-token"] === config.adminToken;
	}

	/* ---------- 网页端：口令登录 + 在线改配置 ---------- */

	const adminPath = resolve(config.adminFile);

	/** 不带 CORS 的响应：浏览器里的跨站脚本读不到内容，也就不存在 CSRF 拿数据的问题 */
	const jsonPlain = (res, code, payload) => {
		res.writeHead(code, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(JSON.stringify(payload));
	};

	const readBody = async (req, limit = 64 * 1024) => {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit) throw new Error("请求体太大");
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString("utf8");
	};

	const clientIp = (req) => {
		const forwarded = String(req.headers["x-real-ip"] ?? "").trim();
		if (forwarded) return forwarded;
		return String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
	};

	// 登录限速：同一 IP 10 分钟内错 5 次 → 锁 5 分钟
	const RATE = { max: 5, windowMs: 10 * 60_000, blockMs: 5 * 60_000 };
	const loginRate = new Map();
	function checkRate(ip) {
		const now = Date.now();
		const rec = loginRate.get(ip);
		if (!rec) return { allowed: true, remaining: RATE.max };
		if (rec.blockedUntil > now) {
			return {
				allowed: false,
				retryAfter: Math.ceil((rec.blockedUntil - now) / 1000),
				remaining: 0,
			};
		}
		if (now - rec.firstAt > RATE.windowMs) {
			loginRate.delete(ip);
			return { allowed: true, remaining: RATE.max };
		}
		if (rec.count >= RATE.max) {
			rec.blockedUntil = now + RATE.blockMs;
			return {
				allowed: false,
				retryAfter: Math.ceil(RATE.blockMs / 1000),
				remaining: 0,
			};
		}
		return { allowed: true, remaining: RATE.max - rec.count };
	}
	function recordFail(ip) {
		const now = Date.now();
		const rec = loginRate.get(ip);
		if (!rec || now - rec.firstAt > RATE.windowMs) {
			loginRate.set(ip, { count: 1, firstAt: now, blockedUntil: 0 });
		} else {
			rec.count += 1;
		}
		if (loginRate.size > 2000) {
			for (const [key, value] of loginRate) {
				if (now - value.firstAt > RATE.windowMs) loginRate.delete(key);
			}
		}
	}

	const runtimeInfo = () => ({
		roomId: config.roomId,
		connected: runtime.connected,
		reason: runtime.reason,
		remainingMs: state.remainingMs(),
		paused: state.paused,
		giftCount: state.giftCount,
		addedMs: state.addedMs,
	});

	const loadAdmin = () => readJson(adminPath).catch(() => null);

	function adminAuth(req) {
		const header = String(req.headers.authorization ?? "");
		const token = header.startsWith("Bearer ") ? header.slice(7) : "";
		if (!token) return { ok: false, code: 401, error: "请先输入口令" };
		return (async () => {
			const admin = await loadAdmin();
			if (!admin?.passwordHash || !admin?.sessionSecret) {
				return { ok: false, code: 503, error: "服务端还没设置口令" };
			}
			const session = verifySession(admin.sessionSecret, token);
			if (!session) {
				return { ok: false, code: 401, error: "登录已过期，请重新输入口令" };
			}
			return { ok: true, session };
		})();
	}

	/** 只把可编辑字段合并回配置文件，别的字段原样保留 */
	async function persistConfig() {
		const current = (await readJson(configFilePath).catch(() => null)) ?? {};
		const merged = { ...current, ...pickEditable(config) };
		await writeJsonAtomic(configFilePath, merged);
		await chmod(configFilePath, 0o600).catch(() => {});
	}

	function applyEditable(value) {
		const roomChanged = value.roomId !== config.roomId;
		config.roomId = value.roomId;
		config.initialMinutes = value.initialMinutes;
		config.cnyToMinutes = value.cnyToMinutes;
		config.ignoreSilverGifts = value.ignoreSilverGifts;
		config.gifts = value.gifts;
		config.guards = value.guards;
		config.caps = value.caps;
		if (roomChanged && !demo) {
			log(`🔀 直播间号改成 ${value.roomId}，重连弹幕`);
			startClient();
		}
		return roomChanged;
	}

	const server = createServer(async (req, res) => {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "127.0.0.1"}`,
		);

		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "content-type, x-timer-token",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			});
			res.end();
			return;
		}

		if (
			req.method === "GET" &&
			(url.pathname === "/state" || url.pathname === "/state.json")
		) {
			json(res, 200, state.snapshot({ ...runtime }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/health") {
			json(res, 200, {
				ok: true,
				connected: runtime.connected,
				reason: runtime.reason,
				roomId: config.roomId,
				remainingMs: state.remainingMs(),
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/admin/login") {
			const ip = clientIp(req);
			const rate = checkRate(ip);
			if (!rate.allowed) {
				jsonPlain(res, 429, {
					ok: false,
					error: `尝试太频繁，${rate.retryAfter} 秒后再试`,
					retryAfter: rate.retryAfter,
				});
				return;
			}
			const admin = await loadAdmin();
			if (!admin?.passwordHash || !admin?.sessionSecret) {
				jsonPlain(res, 503, {
					ok: false,
					error:
						"服务端还没设置口令，先在服务器上执行：node /usr/local/bin/live-timer.mjs --set-password",
				});
				return;
			}
			let payload = {};
			try {
				payload = JSON.parse((await readBody(req)) || "{}");
			} catch {
				jsonPlain(res, 400, { ok: false, error: "请求体不是 JSON" });
				return;
			}
			const password = String(payload.password ?? "");
			if (!password || !verifyPassword(password, admin.passwordHash)) {
				recordFail(ip);
				log(`🔒 网页登录失败（${ip}）`);
				jsonPlain(res, 401, {
					ok: false,
					error: "口令不对",
					remaining: Math.max(0, rate.remaining - 1),
				});
				return;
			}
			loginRate.delete(ip);
			const { token, exp } = signSession(
				admin.sessionSecret,
				Date.now() + SESSION_TTL_MS,
			);
			log(`🔑 网页登录成功（${ip}）`);
			jsonPlain(res, 200, {
				ok: true,
				token,
				exp,
				config: pickEditable(config),
				runtime: runtimeInfo(),
			});
			return;
		}

		if (url.pathname === "/admin/config") {
			const auth = await adminAuth(req);
			if (!auth.ok) {
				jsonPlain(res, auth.code, { ok: false, error: auth.error });
				return;
			}
			if (req.method === "GET") {
				jsonPlain(res, 200, {
					ok: true,
					config: pickEditable(config),
					runtime: runtimeInfo(),
					sessionExp: auth.session.exp,
				});
				return;
			}
			if (req.method === "PUT") {
				let payload = {};
				try {
					payload = JSON.parse((await readBody(req)) || "{}");
				} catch {
					jsonPlain(res, 400, { ok: false, error: "请求体不是 JSON" });
					return;
				}
				const result = normalizeEditable(payload.config);
				if (!result.ok) {
					jsonPlain(res, 400, { ok: false, error: result.error });
					return;
				}
				const roomChanged = applyEditable(result.value);
				try {
					await persistConfig();
				} catch (err) {
					log(`⚠️ 保存配置失败：${err.message}`);
					jsonPlain(res, 500, {
						ok: false,
						error: `已生效但写入文件失败：${err.message}`,
					});
					return;
				}
				log(
					`⚙️ 网页更新配置（${clientIp(req)}）：房间 ${config.roomId}，开局 ${config.initialMinutes} 分钟，礼物 ${Object.keys(config.gifts).length} 条`,
				);
				jsonPlain(res, 200, {
					ok: true,
					config: pickEditable(config),
					runtime: runtimeInfo(),
					roomChanged,
				});
				return;
			}
			jsonPlain(res, 405, { ok: false, error: "只支持 GET / PUT" });
			return;
		}

		if (req.method === "POST" && url.pathname === "/admin/password") {
			const auth = await adminAuth(req);
			if (!auth.ok) {
				jsonPlain(res, auth.code, { ok: false, error: auth.error });
				return;
			}
			let payload = {};
			try {
				payload = JSON.parse((await readBody(req)) || "{}");
			} catch {
				jsonPlain(res, 400, { ok: false, error: "请求体不是 JSON" });
				return;
			}
			const current = String(payload.currentPassword ?? "");
			const next = String(payload.newPassword ?? "");
			const admin = await loadAdmin();
			if (!admin?.passwordHash) {
				jsonPlain(res, 503, { ok: false, error: "服务端还没设置口令" });
				return;
			}
			const ip = clientIp(req);
			if (!current || !verifyPassword(current, admin.passwordHash)) {
				recordFail(ip);
				log(`🔒 改口令失败：当前口令不对（${ip}）`);
				jsonPlain(res, 401, { ok: false, error: "当前口令不对" });
				return;
			}
			if (next.length < 6) {
				jsonPlain(res, 400, { ok: false, error: "新口令至少 6 位" });
				return;
			}
			if (next.length > 200) {
				jsonPlain(res, 400, { ok: false, error: "新口令太长了（≤ 200 字符）" });
				return;
			}
			if (next === current) {
				jsonPlain(res, 400, { ok: false, error: "新口令不能和当前口令一样" });
				return;
			}
			// 换口令的同时换签名密钥：之前发出去的所有会话立即失效，
			// 只给当前这个浏览器发一个新令牌，所以不会把自己踢下线
			const sessionSecret = randomBytes(32).toString("base64");
			const updated = {
				passwordHash: hashPassword(next),
				sessionSecret,
				updatedAt: new Date().toISOString(),
			};
			try {
				await writeJsonAtomic(adminPath, updated);
				await chmod(adminPath, 0o600).catch(() => {});
			} catch (err) {
				log(`⚠️ 写口令文件失败：${err.message}`);
				jsonPlain(res, 500, { ok: false, error: `写入失败：${err.message}` });
				return;
			}
			loginRate.delete(ip);
			const { token, exp } = signSession(
				sessionSecret,
				Date.now() + SESSION_TTL_MS,
			);
			log(`🔑 网页口令已更新（${ip}）`);
			jsonPlain(res, 200, {
				ok: true,
				token,
				exp,
				changedAt: updated.updatedAt,
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/control") {
			// 两种身份都放行：老的控制口令（x-timer-token / 本机调用），
			// 或网页登录态（Authorization: Bearer 会话令牌，配置页的按钮用它）
			const controlAuth = authorized(req) ? { ok: true } : await adminAuth(req);
			if (!controlAuth.ok) {
				json(res, 403, {
					ok: false,
					error: controlAuth.error ?? "口令不对（x-timer-token）",
				});
				return;
			}
			let body = "";
			for await (const chunk of req) body += chunk;
			let payload = {};
			try {
				payload = JSON.parse(body || "{}");
			} catch {
				json(res, 400, { ok: false, error: "请求体不是 JSON" });
				return;
			}
			const minutes = numberFrom(payload.minutes);
			switch (payload.action) {
				case "start":
					state.start();
					log("▶️ 手动开局");
					break;
				case "pause":
					state.pause();
					log("⏸️ 手动暂停");
					break;
				case "resume":
					state.resume();
					log("▶️ 手动继续");
					break;
				case "add":
					state.shift(minutes * 60_000);
					log(`➕ 手动加时 ${minutes} 分钟`);
					break;
				case "sub":
					state.shift(-Math.abs(minutes) * 60_000);
					log(`➖ 手动减时 ${minutes} 分钟`);
					break;
				case "demoGift": {
					const ms = numberFrom(payload.seconds) * 1000 || 60_000;
					grant(ms, {
						kind: "gift",
						user: String(payload.user ?? "测试观众"),
						uid: 0,
						label: String(payload.label ?? "小花花"),
					});
					break;
				}
				default:
					json(res, 400, {
						ok: false,
						error: `不认识的 action：${payload.action}`,
					});
					return;
			}
			json(res, 200, { ok: true, state: state.snapshot({ ...runtime }) });
			return;
		}

		json(res, 404, { ok: false, error: "not found" });
	});

	await new Promise((done) => server.listen(config.port, config.host, done));
	log(
		`🕒 控制接口 http://${config.host}:${config.port}（GET /state，POST /control）`,
	);

	/* ---------- 每秒落盘 ---------- */

	let lastPersist = 0;
	let stopped = false;
	setInterval(() => {
		const snapshot = state.snapshot({ ...runtime });
		writeJsonAtomic(outPath, snapshot).catch((err) =>
			log(`⚠️ 写状态文件失败：${err.message}`),
		);
		const now = Date.now();
		if (now - lastPersist > 5000) {
			lastPersist = now;
			writeJsonAtomic(statePath, state.toPersist()).catch(() => {});
		}
	}, 1000);

	/* ---------- 收尾 ---------- */

	let client = null;

	function onStatus(status) {
		runtime.connected = Boolean(status.connected);
		if (status.connected) {
			runtime.reason = "已连接";
			return;
		}
		if (status.reason) {
			runtime.reason = status.reason;
			log(`📴 ${status.reason}`);
		}
	}

	/** 启一个弹幕连接；改直播间号时会先停掉旧的再启新的 */
	function startClient() {
		if (demo) return;
		client?.stop();
		runtime.connected = false;
		runtime.reason = "连接中";
		client = new DanmakuClient(config, onCommand, onStatus);
		client.run().catch((err) => log(`⚠️ 弹幕客户端退出：${err.message}`));
	}

	if (!demo) {
		startClient();
	} else {
		log(
			'🧪 demo 模式：不连 B 站，用 POST /control {"action":"demoGift"} 模拟礼物',
		);
	}

	const shutdown = async () => {
		if (stopped) return;
		stopped = true;
		log("👋 收尾中…");
		client?.stop();
		await writeJsonAtomic(statePath, state.toPersist()).catch(() => {});
		await writeJsonAtomic(
			outPath,
			state.snapshot({ ...runtime, connected: false }),
		).catch(() => {});
		server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => die(err?.stack ?? String(err)));
