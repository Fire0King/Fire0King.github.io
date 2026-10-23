#!/usr/bin/env node
/**
 * B 站直播事件转发器（用现成库 bili-live-listener 抓，不自己解协议）
 *
 * 职责只有一件事：把 bili-live-listener 抛出的礼物/大航海/醒目留言，
 * 转成计时器认识的 JSON，POST 到本机 http://127.0.0.1:8848/ingest。
 * 计时、状态机、页面全部还是原来那套。
 *
 * 配置直接复用主配置 /var/lib/live-timer/config.json 里的 roomId / cookie / debug。
 * 启动：node listener.mjs
 */

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { BiliLive } from "bili-live-listener";

const MAIN_CONFIG = process.env.LIVE_TIMER_CONFIG || "/var/lib/live-timer/config.json";
const INGEST = process.env.LISTENER_INGEST || "http://127.0.0.1:8848/ingest";
const RECONNECT_MS = 5000;
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 库里自带的 getRoomConf 用的是未签名的 getDanmuInfo，B 站现在一律返回 -352，
 * 所以 token 由我们自己按 wbi 签名取，再交给 BiliLive 去连（解析仍走这个库）。
 */
const WBI_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
	42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];

async function wbiKey(cookie) {
	const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
		headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/", Cookie: cookie },
	});
	const json = await res.json();
	const img = json?.data?.wbi_img?.img_url ?? "";
	const sub = json?.data?.wbi_img?.sub_url ?? "";
	const name = (url) => url.split("/").pop()?.split(".")[0] ?? "";
	const shuffled = name(img) + name(sub);
	if (shuffled.length < 64) throw new Error("拿不到 wbi key");
	return {
		key: WBI_TAB.map((i) => shuffled[i]).join(""),
		uid: Number(json?.data?.mid) || 0,
	};
}

/** nav 有时要 buvid3 才认登录态，补一个 */
async function withBuvid(cookie) {
	try {
		const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
			headers: { "User-Agent": UA },
		});
		const json = await res.json();
		const buvid = json?.data?.b_3 ?? "";
		return buvid ? `buvid3=${buvid}; ${cookie}` : cookie;
	} catch {
		return cookie;
	}
}

function signed(params, mixin) {
	const wts = String(Math.round(Date.now() / 1000));
	const all = { ...params, wts };
	const query = Object.keys(all)
		.sort()
		.map(
			(k) =>
				`${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`,
		)
		.join("&");
	const wRid = createHash("md5").update(query + mixin).digest("hex");
	return `${query}&w_rid=${wRid}`;
}

async function getToken(roomId, rawCookie) {
	const cookie = await withBuvid(rawCookie);
	const { key, uid } = await wbiKey(cookie);
	const res = await fetch(
		`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signed({ id: roomId, type: 0 }, key)}`,
		{
			headers: {
				"User-Agent": UA,
				Referer: `https://live.bilibili.com/${roomId}`,
				Cookie: cookie,
			},
		},
	);
	const json = await res.json();
	if (json?.code !== 0 || !json?.data?.token) {
		throw new Error(`getDanmuInfo 失败 code=${json?.code} message=${json?.message}`);
	}
	return { token: json.data.token, uid };
}

function log(...args) {
	const t = new Date().toLocaleString("zh-CN", { hour12: false });
	console.log(`[${t}]`, ...args);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function readMainConfig() {
	const raw = await readFile(MAIN_CONFIG, "utf8");
	return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

let debug = false;

async function ingest(payload) {
	try {
		const res = await fetch(INGEST, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			log(`⚠️ 转发失败 HTTP ${res.status}`);
			return;
		}
		const data = await res.json();
		if (debug) {
			log(
				`📤 ${payload.type} ${payload.uname ?? ""} ${payload.giftName ?? ""} → 已累计 ${data.giftCount} 次`,
			);
		}
	} catch (err) {
		log(`⚠️ 连不上计时器：${err.message}`);
	}
}

async function main() {
	const main = await readMainConfig();
	debug = Boolean(main.debug);
	const roomId = Number(main.roomId);
	const cookie = String(main.cookie ?? "").trim();
	if (!roomId) throw new Error("主配置里没有 roomId");
	if (!cookie) {
		throw new Error(
			"主配置里没有 cookie —— bili-live-listener 需要登录态才能收到数据包",
		);
	}

	// 配置被网页改过（比如换了 cookie）就自动重启，省得每次进服务器
	let configStamp = 0;
	try {
		configStamp = (await stat(MAIN_CONFIG)).mtimeMs;
	} catch {
		configStamp = 0;
	}
	setInterval(async () => {
		try {
			const stamp = (await stat(MAIN_CONFIG)).mtimeMs;
			if (stamp !== configStamp) {
				log("🔄 检测到配置更新，退出以让 systemd 重启（新 cookie 立刻生效）");
				process.exit(0);
			}
		} catch {
			// 文件暂时读不到就忽略
		}
	}, 20_000);

	const { token, uid } = await getToken(roomId, cookie);
	if (!uid) {
		log(
			"⚠️ 这次没拿到 uid（cookie 可能已失效）：B 站只会稀疏推送，礼物很可能收不到；请在网页「登录 Cookie」里换成新的 SESSDATA",
		);
	} else {
		log(`🔐 登录态就绪：uid=${uid}，房号=${roomId}，key 长度=${token.length}`);
	}

	let stopped = false;
	const connect = async () => {
		const live = new BiliLive(Number(roomId), { key: token, uid });

		live.onLive(() => log("✅ 已进入直播间，开始接收事件"));
		live.onHeartbeat(() => {
			if (debug) log("💓 心跳");
		});
		live.onError((err) => log(`⚠️ 连接错误：${err?.message ?? err}`));
		live.onClose(() => log("📴 连接关闭"));

		live.onGift(({ data }) => {
			ingest({
				type: "gift",
				uid: data.user?.uid ?? 0,
				uname: data.user?.uname ?? "观众",
				giftId: data.giftId,
				giftName: data.giftName,
				num: data.num ?? 1,
				price: data.price ?? 0,
				coinType: data.coinType ?? "gold",
				timestamp: data.timestamp ?? Math.floor(Date.now() / 1000),
			});
		});

		live.onGuardBuy(({ data }) => {
			ingest({
				type: "guard",
				uid: data.user?.uid ?? 0,
				uname: data.user?.uname ?? "观众",
				giftName: "大航海",
				guardLevel: data.guardLevel ?? data.guard_level ?? 0,
				num: data.num ?? 1,
			});
		});

		live.onSuperChat(({ data }) => {
			ingest({
				type: "superchat",
				uid: data.user?.uid ?? 0,
				uname: data.user?.uname ?? "观众",
				price: data.price ?? 0,
			});
		});

		// 关键补丁：B 站现在推的是 SEND_GIFT_V2（base64 protobuf），
		// 这个库还是 2022 年的解析逻辑，只认旧版 SEND_GIFT。
		// 所以把 V2 的原始数据转给计时器，由它解 protobuf。
		if (typeof live.onRawMessage === "function") {
			live.onRawMessage("SEND_GIFT_V2", (msg) => {
				ingest({ type: "gift_v2", data: msg?.data ?? msg });
			});
		}

		if (debug && typeof live.onRawMessage === "function") {
			// 兜底：库没覆盖的事件，至少能看到 cmd 名字
			live.onRawMessage("msg", (msg) => {
				if (msg?.cmd) log(`🔍 事件流：${msg.cmd}`);
			});
		}

		const closed = new Promise((resolve) => {
			live.onClose(() => resolve("close"));
			live.onError(() => resolve("error"));
		});

		await closed;
		return () => live.close();
	};

	while (!stopped) {
		try {
			const close = await connect();
			close?.();
		} catch (err) {
			log(`⚠️ 连接失败：${err?.message ?? err}`);
		}
		if (stopped) break;
		log(`↻ ${RECONNECT_MS / 1000} 秒后重连`);
		await sleep(RECONNECT_MS);
	}

	process.on("SIGTERM", () => {
		stopped = true;
	});
}

main().catch((err) => {
	log(`❌ 启动失败：${err?.message ?? err}`);
	process.exit(1);
});
