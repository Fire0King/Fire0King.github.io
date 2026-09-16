#!/usr/bin/env node
/**
 * 直播数据采集脚本
 * ---------------------------------------------------------------------------
 * 由 .github/workflows/live-data.yml 定时调用（默认每 10 分钟），也可以本地手动运行：
 *
 *   cd scripts/live-data && npm install        # 首次安装依赖（@ikenxuan/amagi）
 *   node collect.mjs                           # 正式采集（本地需要能访问 B站/抖音）
 *   node collect.mjs --dry-run                 # 只打印结果，不写文件
 *   node collect.mjs --dump                    # 打印接口原始返回，用于排查字段路径
 *   node collect.mjs --demo                    # 写入演示数据，仅用于本地预览页面
 *
 * 工作方式（"状态机"）：
 *   每次运行拉取一次各平台的直播状态与粉丝数，与 src/data/live/streams.json 中的
 *   active 场次对比：
 *     · 之前没在播、现在在播  -> 记录开播时间（B站可用 live_time 精确到秒）
 *     · 之前在播、现在下播    -> 结算时长并写入 records
 *     · 标题变化              -> 更新 active 里的标题
 *   因此"播了多久"的精度 = 轮询间隔（默认 10 分钟）。
 *
 * 环境变量（只在 CI 里配置，注意不要提交到仓库）：
 *   BILIBILI_COOKIE   可选，B站 Cookie（SESSDATA=...），能降低风控概率
 *   DOUYIN_COOKIE     可选但强烈建议，抖音 Cookie（ttwid=...; msToken=...）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");

const CONFIG_PATH = path.join(ROOT_DIR, "src/config/live-report.config.json");
const STREAMS_PATH = path.join(ROOT_DIR, "src/data/live/streams.json");
const FOLLOWERS_PATH = path.join(ROOT_DIR, "src/data/live/followers.json");

const PLATFORMS = ["bilibili", "douyin"];
const DATA_VERSION = 1;

// ── 命令行参数 ────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const DUMP = args.has("--dump");
const DEMO = args.has("--demo");
const FORCE_FOLLOWER = args.has("--force-follower");
const STRICT = args.has("--strict");

// ── 工具函数 ──────────────────────────────────────────────────────────────

function log(...messages) {
	console.log("[live-data]", ...messages);
}

function warn(...messages) {
	console.warn("[live-data]", ...messages);
}

function readJson(filePath, fallback) {
	if (!existsSync(filePath)) return fallback;
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		warn(
			`读取 ${path.relative(ROOT_DIR, filePath)} 失败，使用默认值：${error.message}`,
		);
		return fallback;
	}
}

function writeJson(filePath, value) {
	const serialized = `${JSON.stringify(value, null, 2)}\n`;
	if (DRY_RUN) {
		log(`[dry-run] 将写入 ${path.relative(ROOT_DIR, filePath)}`);
		return false;
	}
	mkdirSync(path.dirname(filePath), { recursive: true });
	const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
	if (previous === serialized) return false;
	writeFileSync(filePath, serialized, "utf8");
	log(`已更新 ${path.relative(ROOT_DIR, filePath)}`);
	return true;
}

function pad(value) {
	return String(value).padStart(2, "0");
}

/** 在指定时区里取日期/时间片段 */
function partsInTimeZone(date, timeZone) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).formatToParts(date);
	const result = {};
	for (const part of parts) {
		if (part.type !== "literal") result[part.type] = part.value;
	}
	return result;
}

/** 时区偏移，如 +08:00 */
function offsetInTimeZone(date, timeZone) {
	const raw = partsInTimeZone(date, timeZone).timeZoneName || "GMT";
	if (raw === "GMT" || raw === "UTC") return "+00:00";
	const match = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
	if (!match) return "+00:00";
	return `${match[1]}${pad(match[2])}:${match[3] ?? "00"}`;
}

/** 日期键 YYYY-MM-DD（配置时区） */
export function dateKeyOf(date, timeZone) {
	const parts = partsInTimeZone(date, timeZone);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 带时区偏移的 ISO 字符串，例如 2026-02-14T20:01:05+08:00 */
export function isoInTimeZone(date, timeZone) {
	const parts = partsInTimeZone(date, timeZone);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetInTimeZone(date, timeZone)}`;
}

/**
 * 把 B站返回的 "2026-09-15 19:00:55"（北京时间，无时区）解析成 Date
 * 其他平台/接口若返回标准 ISO 字符串则直接交给 Date 解析
 */
export function parsePlatformTime(value, timeZone) {
	if (!value || typeof value !== "string") return null;
	if (/^0{4}-0{2}-0{2}/.test(value)) return null; // 未开播时 B站 返回全 0
	const normalized = value.includes("T") ? value : value.replace(" ", "T");
	const withZone = /[+-]\d{2}:?\d{2}$|Z$/.test(normalized)
		? normalized
		: `${normalized}${offsetInTimeZone(new Date(), timeZone)}`;
	const parsed = new Date(withZone);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 在对象里按候选字段名广度优先查找第一个非空值 */
function deepFind(source, candidateKeys, maxDepth = 6) {
	if (!source || typeof source !== "object") return undefined;
	const queue = [{ value: source, depth: 0 }];
	const visited = new Set();
	while (queue.length > 0) {
		const { value, depth } = queue.shift();
		if (!value || typeof value !== "object" || visited.has(value)) continue;
		visited.add(value);
		for (const key of candidateKeys) {
			const found = value[key];
			if (found !== undefined && found !== null && found !== "") return found;
		}
		if (depth >= maxDepth) continue;
		for (const child of Object.values(value)) {
			if (child && typeof child === "object") {
				queue.push({ value: child, depth: depth + 1 });
			}
		}
	}
	return undefined;
}

function toNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 描述一个 Cookie 字符串：只输出字段名，绝不输出值，可安全打进 CI 日志。
 * 用途：判断 Secret 是否注入成功、关键字段是否齐全（例如抖音的 ttwid）。
 */
function describeCookie(cookie) {
	if (!cookie?.trim()) return "未注入（环境变量为空）";
	const names = cookie
		.split(";")
		.map((part) => part.split("=")[0]?.trim())
		.filter(Boolean);
	const keyFields = [
		"ttwid",
		"msToken",
		"odin_tt",
		"passport_csrf_token",
		"SESSDATA",
	];
	const present = keyFields.filter((name) =>
		names.some((item) => item.toLowerCase() === name.toLowerCase()),
	);
	return `已注入 ${names.length} 项${present.length > 0 ? `，含 ${present.join(" / ")}` : "，⚠️ 未发现关键字段"}`;
}

/**
 * amagi 的返回值形如 { success, code, message, data }。
 * 关键：接口失败时它是返回 success:false 而不是抛异常 —— 必须显式当失败处理，
 * 否则"接口挂了/被风控"会被误判成"未开播"，进而把正在进行的场次错误地结算掉。
 */
function unwrap(result, label) {
	if (!result || result.success === false) {
		const reason =
			result?.error?.errorDescription || result?.message || `${label} 请求失败`;
		throw new Error(reason);
	}
	return result.data ?? result;
}

// ── 平台采集 ──────────────────────────────────────────────────────────────

/**
 * B站：用户名片拿粉丝数，直播状态拿是否在播/标题，房间信息拿精确开播时间
 */
async function collectBilibili(client, config) {
	const uid = Number(config.uid);
	if (!Number.isFinite(uid) || uid <= 0) {
		return {
			platform: "bilibili",
			ok: false,
			error: "bilibili.uid 未配置或不是数字",
		};
	}

	const result = { platform: "bilibili", ok: true, live: false };

	// 1) 粉丝数
	try {
		const raw = await client.bilibili.fetcher.fetchUserCard({ host_mid: uid });
		if (DUMP)
			log("bilibili.fetchUserCard ->", JSON.stringify(raw)?.slice(0, 800));
		const body = unwrap(raw, "B站用户名片");
		const payload = body?.data ?? body;
		const fans = deepFind(payload, ["fans", "follower"]);
		result.followers = toNumber(fans, 0);
		result.name = deepFind(payload, ["name", "uname"]);
	} catch (error) {
		warn(`B站 粉丝数获取失败：${error?.message ?? error}`);
		result.followersError = String(error?.message ?? error);
	}

	// 2) 直播状态（拿不到就是失败，绝不能当成"未开播"）
	try {
		const raw = await client.bilibili.fetcher.fetchUserLiveStatus({
			host_mid: uid,
		});
		if (DUMP)
			log(
				"bilibili.fetchUserLiveStatus ->",
				JSON.stringify(raw)?.slice(0, 1200),
			);
		const body = unwrap(raw, "B站直播状态");
		const payload = body?.data ?? body;
		const liveStatus = toNumber(
			deepFind(payload, ["liveStatus", "live_status"]),
			0,
		);
		result.live = liveStatus === 1;
		result.title = deepFind(payload, ["title"]);
		result.url = deepFind(payload, ["url", "link"]);
		result.roomId = deepFind(payload, ["roomid", "room_id"]);
		result.cover = deepFind(payload, ["cover", "user_cover", "keyframe"]);
	} catch (error) {
		warn(`B站 直播状态获取失败：${error?.message ?? error}`);
		result.ok = false;
		result.error = String(error?.message ?? error);
		return result;
	}

	// 3) 精确开播时间（配置了直播间号才有意义）
	const roomId = config.roomId || result.roomId;
	if (result.live && roomId) {
		try {
			const raw = await client.bilibili.fetcher.fetchLiveRoomInfo({
				room_id: String(roomId),
			});
			if (DUMP)
				log(
					"bilibili.fetchLiveRoomInfo ->",
					JSON.stringify(raw)?.slice(0, 800),
				);
			const body = unwrap(raw, "B站直播间信息");
			const payload = body?.data ?? body;
			const liveStatus = toNumber(
				deepFind(payload, ["live_status", "liveStatus"]),
				0,
			);
			// live_status: 0=未开播 1=直播中 2=轮播
			if (liveStatus === 1) {
				const startedAt = parsePlatformTime(
					deepFind(payload, ["live_time"]),
					config.timezone,
				);
				if (startedAt) result.startedAt = startedAt;
			}
			result.title = deepFind(payload, ["title"]) || result.title;
			result.roomId = deepFind(payload, ["room_id"]) || result.roomId;
		} catch (error) {
			warn(
				`B站 直播间信息获取失败（不影响在播判断）：${error?.message ?? error}`,
			);
		}
	}

	return result;
}

/**
 * 抖音：用户主页拿粉丝数与直播状态，直播间接口拿直播标题
 *
 * 重要：抖音 web 接口**必须带 Cookie**（ttwid / msToken），匿名请求会返回空响应，
 * amagi 会以 success:false 报 "抖音ck可能已经失效"。请配置仓库 Secret DOUYIN_COOKIE。
 * 字段结构随版本变动较多，取不到时用 --dump 看原始返回，再把字段名补进下面的候选列表。
 */
async function collectDouyin(client, config) {
	if (!config.secUid && !config.webRid) {
		return {
			platform: "douyin",
			ok: false,
			error: "douyin.secUid / douyin.webRid 均未配置",
		};
	}

	/** ok 取"至少成功一个接口"，失败的接口数单独记录 */
	const result = { platform: "douyin", ok: false, live: false };
	let attempts = 0;
	let failures = 0;
	let lastError = "";

	// 1) 用户主页：粉丝数 + 是否在直播
	if (config.secUid) {
		attempts += 1;
		try {
			const raw = await client.douyin.fetcher.fetchUserProfile({
				sec_uid: config.secUid,
			});
			if (DUMP)
				log("douyin.fetchUserProfile ->", JSON.stringify(raw)?.slice(0, 1500));
			const body = unwrap(raw, "抖音用户主页");
			const payload = body?.user ?? body?.data ?? body;
			result.followers = toNumber(
				deepFind(payload, ["follower_count", "fans", "follower"]),
				0,
			);
			result.name = deepFind(payload, ["nickname", "name"]);
			const liveStatus = toNumber(deepFind(payload, ["live_status"]), 0);
			if (liveStatus === 1) result.live = true;
			result.roomId = deepFind(payload, ["room_id_str", "room_id"]);
			result.cover = deepFind(payload, ["cover"]);
		} catch (error) {
			failures += 1;
			lastError = String(error?.message ?? error);
			warn(`抖音 用户主页获取失败：${lastError}`);
		}
	}

	// 2) 直播间信息：直播标题 / 房间状态
	// room_id 在 amagi 里是必填且不能为空，用 web_rid 顶替即可（请求实际以 web_rid 为准）
	if (config.webRid) {
		attempts += 1;
		try {
			const raw = await client.douyin.fetcher.fetchLiveRoomInfo({
				room_id: String(config.roomId || config.webRid),
				web_rid: String(config.webRid),
			});
			if (DUMP)
				log("douyin.fetchLiveRoomInfo ->", JSON.stringify(raw)?.slice(0, 1500));
			const body = unwrap(raw, "抖音直播间信息");
			const payload = body?.data ?? body;
			// status: 2=直播中，4=已结束
			const status = toNumber(deepFind(payload, ["status"]), 0);
			const roomStatus = toNumber(deepFind(payload, ["room_status"]), 0);
			if (status === 2 || roomStatus === 2) result.live = true;
			if (status === 4 || roomStatus === 4) result.live = false;
			result.title = deepFind(payload, ["title"]) || result.title;
			result.cover = deepFind(payload, ["cover"]) || result.cover;
		} catch (error) {
			failures += 1;
			lastError = String(error?.message ?? error);
			warn(`抖音 直播间信息获取失败：${lastError}`);
		}
	}

	result.ok = attempts > 0 && failures < attempts;
	if (!result.ok) {
		result.error = `${lastError || "抖音接口不可用"}（请配置仓库 Secret DOUYIN_COOKIE）`;
	}
	if (result.live && config.webRid) {
		result.url = `https://live.douyin.com/${config.webRid}`;
	}

	return result;
}

// ── 状态机 ────────────────────────────────────────────────────────────────

export function emptyStreams(config) {
	return {
		version: DATA_VERSION,
		updatedAt: null,
		timezone: config.timezone,
		intervalMinutes: config.collector.intervalMinutes,
		active: {},
		records: [],
	};
}

export function emptyFollowers() {
	return { version: DATA_VERSION, updatedAt: null, series: {} };
}

/** 把 current 与 active 对比，产出新的 active 与新增的历史记录 */
export function reconcile({ streams, snapshots, config, now }) {
	const active = { ...(streams.active ?? {}) };
	const newRecords = [];
	let changed = false;
	// 标题变化的最小写入间隔：主播频繁改标题时不必每次都产生一次提交
	// （GitHub Pages / Cloudflare Pages 都有部署频率限制）
	const titleIntervalMs =
		Math.max(0, config.collector.titleUpdateIntervalMinutes ?? 30) * 60 * 1000;

	for (const snapshot of snapshots) {
		const platform = snapshot.platform;
		const current = active[platform];

		if (!snapshot.ok) continue;

		if (snapshot.live) {
			const startedAt = snapshot.startedAt ?? now;
			if (!current) {
				active[platform] = {
					platform,
					title: snapshot.title || "",
					start: isoInTimeZone(startedAt, config.timezone),
					titleUpdatedAt: isoInTimeZone(now, config.timezone),
					url: snapshot.url,
					roomId: snapshot.roomId ? String(snapshot.roomId) : undefined,
					cover: snapshot.cover,
				};
				changed = true;
				log(`${platform} 开播：${snapshot.title || "(无标题)"}`);
			} else if (snapshot.title && snapshot.title !== current.title) {
				const lastTitleUpdate = current.titleUpdatedAt
					? new Date(current.titleUpdatedAt).getTime()
					: 0;
				// 用传入的 now 而不是 Date.now()，保证节流判断可被测试且与本次运行时间一致
				const intervalElapsed =
					titleIntervalMs === 0 ||
					now.getTime() - lastTitleUpdate >= titleIntervalMs;
				if (intervalElapsed) {
					active[platform] = {
						...current,
						title: snapshot.title,
						titleUpdatedAt: isoInTimeZone(now, config.timezone),
					};
					changed = true;
					log(`${platform} 标题更新：${snapshot.title}`);
				} else {
					log(
						`${platform} 标题变化但处于节流间隔内，本次跳过：${snapshot.title}`,
					);
				}
			}
		} else if (current) {
			const start = new Date(current.start);
			const end = now;
			const durationSeconds = Math.max(
				0,
				Math.round((end.getTime() - start.getTime()) / 1000),
			);
			newRecords.push({
				id: `${platform}-${current.start}`,
				platform,
				title: current.title || "",
				date: dateKeyOf(start, config.timezone),
				start: current.start,
				end: isoInTimeZone(end, config.timezone),
				durationSeconds,
				url: current.url,
				roomId: current.roomId,
				cover: current.cover,
			});
			delete active[platform];
			changed = true;
			log(
				`${platform} 下播：时长 ${Math.round(durationSeconds / 60)} 分钟（${current.title || "无标题"}）`,
			);
		}
	}

	return { active, newRecords, changed };
}

/** 按保留天数裁剪历史记录 */
export function applyRetention(records, config, now = new Date()) {
	const days = config.collector.retentionDays;
	if (!days || days <= 0) return records;
	const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return records.filter((record) => {
		const start = new Date(record.start);
		return Number.isNaN(start.getTime()) || start >= threshold;
	});
}

/** 写入粉丝快照：同一天只保留一个点，且与上次写入间隔达到配置小时数才更新 */
export function updateFollowers({ followers, snapshots, config, now, force }) {
	let changed = false;
	const today = dateKeyOf(now, config.timezone);
	const intervalMs =
		Math.max(1, config.collector.followerSnapshotIntervalHours) * 3600 * 1000;

	for (const snapshot of snapshots) {
		if (
			!snapshot.ok ||
			!Number.isFinite(snapshot.followers) ||
			snapshot.followers <= 0
		) {
			continue;
		}
		const platform = snapshot.platform;
		const series = followers.series[platform] ?? { total: 0, points: [] };
		const points = [...(series.points ?? [])].filter(
			(point) => point.date !== today,
		);
		const previousToday = (series.points ?? []).find(
			(point) => point.date === today,
		);
		const lastWriteAt = series.snapshotAt
			? new Date(series.snapshotAt).getTime()
			: 0;
		const isFirstSnapshotToday = !previousToday;
		// 用传入的 now 而不是 Date.now()，这样状态机可以被测试
		const intervalElapsed = now.getTime() - lastWriteAt >= intervalMs;

		if (!isFirstSnapshotToday && !intervalElapsed && !force) continue;
		if (previousToday && previousToday.total === snapshot.followers && !force)
			continue;

		points.push({ date: today, total: snapshot.followers });
		points.sort((left, right) => left.date.localeCompare(right.date));
		followers.series[platform] = {
			name: series.name || snapshot.name,
			total: snapshot.followers,
			snapshotAt: isoInTimeZone(now, config.timezone),
			points,
		};
		changed = true;
	}

	return changed;
}

// ── 演示数据（仅用于本地预览页面效果） ────────────────────────────────────

function buildDemoData(config) {
	const now = new Date();
	const timeZone = config.timezone;
	const streams = emptyStreams(config);
	const followers = emptyFollowers();
	const titles = [
		"【杂谈】随便聊聊最近的事",
		"【歌回】点歌台营业中",
		"【游戏】今天也在受苦",
		"【杂谈】周末快乐",
		"【学习】一起写代码吧",
	];

	for (const platform of PLATFORMS) {
		const series = {
			name: platform === "bilibili" ? "Demo Channel" : "Demo 抖音",
			total: 0,
			points: [],
		};
		for (let dayOffset = 89; dayOffset >= 0; dayOffset -= 1) {
			const day = new Date(now.getTime() - dayOffset * 86400000);
			const dateKey = dateKeyOf(day, timeZone);
			// 粉丝：每天随机 +1 ~ +30，偶尔掉粉
			const previous = series.points[series.points.length - 1]?.total ?? 1000;
			const delta = Math.round((Math.random() - 0.25) * 30);
			const total = Math.max(0, previous + delta);
			series.points.push({ date: dateKey, total });
			series.total = total;

			// 直播：约 40% 的日子开播 1~2 场
			if (Math.random() < 0.45) {
				const sessions = Math.random() < 0.2 ? 2 : 1;
				for (let index = 0; index < sessions; index += 1) {
					const startHour = 19 + index * 2;
					const start = new Date(day);
					start.setHours(startHour, Math.floor(Math.random() * 50), 0, 0);
					const minutes = 60 + Math.floor(Math.random() * 180);
					const end = new Date(start.getTime() + minutes * 60000);
					streams.records.push({
						id: `${platform}-${isoInTimeZone(start, timeZone)}`,
						platform,
						title: titles[Math.floor(Math.random() * titles.length)],
						date: dateKeyOf(start, timeZone),
						start: isoInTimeZone(start, timeZone),
						end: isoInTimeZone(end, timeZone),
						durationSeconds: minutes * 60,
						url:
							platform === "bilibili"
								? "https://live.bilibili.com/"
								: "https://live.douyin.com/",
					});
				}
			}
		}
		followers.series[platform] = series;
	}

	streams.records.sort((left, right) => left.start.localeCompare(right.start));
	// 造一个"正在直播"的场次，方便预览直播中的样式
	const liveStart = new Date(now.getTime() - 95 * 60000);
	streams.active = {
		bilibili: {
			platform: "bilibili",
			title: "【杂谈】正在直播中（演示数据）",
			start: isoInTimeZone(liveStart, timeZone),
			url: "https://live.bilibili.com/",
		},
	};
	streams.updatedAt = isoInTimeZone(now, timeZone);
	followers.updatedAt = streams.updatedAt;
	return { streams, followers };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
	const config = readJson(CONFIG_PATH, null);
	if (!config) {
		throw new Error(`找不到配置文件：${path.relative(ROOT_DIR, CONFIG_PATH)}`);
	}
	if (!config.timezone) config.timezone = "Asia/Shanghai";
	if (!config.collector) {
		config.collector = {
			intervalMinutes: 10,
			followerSnapshotIntervalHours: 6,
			retentionDays: 0,
		};
	}

	if (DEMO) {
		const { streams, followers } = buildDemoData(config);
		writeJson(STREAMS_PATH, streams);
		writeJson(FOLLOWERS_PATH, followers);
		log("已写入演示数据（仅用于本地预览，请勿提交到仓库）");
		return;
	}

	const streams = readJson(STREAMS_PATH, emptyStreams(config));
	const followers = readJson(FOLLOWERS_PATH, emptyFollowers());
	const now = new Date();

	const enabled = PLATFORMS.filter(
		(platform) => config[platform]?.enable !== false,
	);
	if (enabled.length === 0) {
		log("没有启用任何平台，跳过采集");
		return;
	}

	const { default: amagi } = await import("@ikenxuan/amagi").catch((error) => {
		throw new Error(
			`未能加载 @ikenxuan/amagi，请先在 scripts/live-data 目录执行 npm install（${error.message}）`,
		);
	});

	const client = amagi({
		cookies: {
			bilibili: process.env.BILIBILI_COOKIE ?? "",
			douyin: process.env.DOUYIN_COOKIE ?? "",
		},
	});

	// 诊断：只打印 Cookie 的字段名与数量，绝不打印值（可安全留在 CI 日志里）
	// 用来一眼判断 Secret 有没有注入、关键项在不在
	if (enabled.includes("bilibili")) {
		log(`B站 Cookie：${describeCookie(process.env.BILIBILI_COOKIE)}`);
	}
	if (enabled.includes("douyin")) {
		log(`抖音 Cookie：${describeCookie(process.env.DOUYIN_COOKIE)}`);
	}

	const snapshots = [];
	if (enabled.includes("bilibili")) {
		snapshots.push(await collectBilibili(client, config.bilibili));
	}
	if (enabled.includes("douyin")) {
		snapshots.push(await collectDouyin(client, config.douyin));
	}

	for (const snapshot of snapshots) {
		log(
			`${snapshot.platform}: ${snapshot.ok ? (snapshot.live ? "直播中" : "未开播") : `采集失败(${snapshot.error})`}` +
				(snapshot.followers ? `，粉丝 ${snapshot.followers}` : ""),
		);
	}

	const successful = snapshots.filter((snapshot) => snapshot.ok);
	if (successful.length === 0) {
		warn("所有平台都采集失败，本次不写入任何数据");
		if (STRICT) process.exitCode = 1;
		return;
	}

	// 直播场次状态机
	const { active, newRecords, changed } = reconcile({
		streams,
		snapshots,
		config,
		now,
	});

	if (changed) {
		streams.active = active;
		streams.records = applyRetention(
			[...(streams.records ?? []), ...newRecords].sort((left, right) =>
				left.start.localeCompare(right.start),
			),
			config,
			now,
		);
		streams.updatedAt = isoInTimeZone(now, config.timezone);
		streams.timezone = config.timezone;
		streams.intervalMinutes = config.collector.intervalMinutes;
		writeJson(STREAMS_PATH, streams);
	} else {
		log("直播状态无变化，未改动 streams.json");
	}

	// 粉丝快照
	const followersChanged = updateFollowers({
		followers,
		snapshots: successful,
		config,
		now,
		force: FORCE_FOLLOWER,
	});
	if (followersChanged) {
		followers.updatedAt = isoInTimeZone(now, config.timezone);
		writeJson(FOLLOWERS_PATH, followers);
	} else {
		log("粉丝快照未到写入间隔，未改动 followers.json");
	}
}

// 只有直接运行本文件时才执行采集；
// 被测试文件 import 时（verify-state-machine.mjs）只导出状态机函数，不产生副作用
const isDirectRun =
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
	main().catch((error) => {
		console.error("[live-data] 运行失败：", error);
		process.exitCode = 1;
	});
}
