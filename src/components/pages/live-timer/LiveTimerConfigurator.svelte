<script lang="ts">
/**
 * 直播加时 · 配置台
 *
 * 这个页面只做三件事：
 *   1. 把叠层的样式参数（位置/缩放/文案/配色）即时预览出来；
 *   2. 生成可直接粘进 OBS 浏览器源的地址；
 *   3. 生成服务端能直接用的配置片段（礼物 → 分钟、上限）。
 *
 * 页面是纯静态的，不会写服务器上的文件 —— 配置生成后由你自己覆盖到
 * /etc/live-timer/config.json，再 systemctl restart live-timer。
 */
import { onMount } from "svelte";

interface GiftRow {
	id: number;
	name: string;
	minutes: number;
}

const BASE = import.meta.env.BASE_URL;
const OVERLAY_PATH = `${BASE}live-timer/`;
const DEFAULT_LABEL = "距下播还有";

const POSITIONS: { value: string; name: string }[] = [
	{ value: "tl", name: "左上" },
	{ value: "tc", name: "中上" },
	{ value: "tr", name: "右上" },
	{ value: "bl", name: "左下" },
	{ value: "bc", name: "中下" },
	{ value: "br", name: "右下" },
];

let roomId = $state("1750753391");
let initialMinutes = $state(120);
let cnyToMinutes = $state(1);
let ignoreSilver = $state(true);

let rowSeq = 3;
let giftRows = $state<GiftRow[]>([
	{ id: 1, name: "小心心", minutes: 0 },
	{ id: 2, name: "小花花", minutes: 2 },
	{ id: 3, name: "辣条", minutes: 0 },
]);

let guardCaptain = $state(30);
let guardAdmiral = $state(60);
let guardGovernor = $state(120);

let perGift = $state(60);
let perUser = $state(10);
let totalCap = $state(480);

let pos = $state("bl");
let scale = $state(1);
let label = $state(DEFAULT_LABEL);
let accent = $state("#FB7299");
let theme = $state("dark");
let showGifts = $state(true);
let showBar = $state(true);
let overtime = $state(true);

let origin = $state("");
let copied = $state("");
let previewUrl = $state(`${OVERLAY_PATH}?mock=1&bg=1&mockMinutes=120`);

/* ---------- 服务器配置：口令登录后直接在线读写 ---------- */

let apiBase = $state(`${BASE}live-timer-api`);

interface ServerConfig {
	roomId: number;
	initialMinutes: number;
	cnyToMinutes: number;
	ignoreSilverGifts: boolean;
	gifts: Record<string, number>;
	guards: Record<string, number>;
	caps: {
		perGiftMinutes: number;
		perUserPerMinute: number;
		totalMinutes: number;
	};
	/** 只读标记：服务端是否已配置登录 cookie（值永远不会下发） */
	cookieSet?: boolean;
}

interface RuntimeInfo {
	roomId: number;
	connected: boolean;
	reason: string;
	remainingMs: number;
	paused: boolean;
	giftCount: number;
	addedMs: number;
	/** 1=直播中，0=未开播（未开播时 B 站不推礼物事件） */
	liveStatus?: number | null;
	/** B 站登录态：false 表示 cookie 已失效，收不到礼物 */
	authOk?: boolean | null;
	authReason?: string;
}

/** 服务器记录下来的最近礼物（含没加时的），用来配礼物表 */
interface RecentGift {
	at: number;
	uid: number;
	uname: string;
	giftId: string;
	giftName: string;
	num: number;
	price: number;
	coinType: string;
	ms: number;
	applied: boolean;
	reason: string;
}

let loggedIn = $state(false);
let token = $state("");
let loginPassword = $state("");
let loginBusy = $state(false);
let loginError = $state("");
let saveBusy = $state(false);
let saveMsg = $state("");
let saveError = $state("");
let runtime = $state<RuntimeInfo | null>(null);

let currentPwd = $state("");
let newPwd = $state("");
let confirmPwd = $state("");
let pwdBusy = $state(false);
let pwdMsg = $state("");
let pwdBad = $state(false);

let ctlBusy = $state(false);
let ctlMsg = $state("");
let ctlBad = $state(false);
let customMinutes = $state(10);

/** 登录 cookie：只写不读，界面上只显示「是否已设置」 */
let cookieInput = $state("");
let cookieSet = $state(false);
let clearCookie = $state(false);
let recentGifts = $state<RecentGift[]>([]);

const runtimeLabel = $derived.by(() => {
	if (!runtime) return "状态未知";
	const parts = [runtime.connected ? "弹幕已连接" : "弹幕未连接"];
	if (runtime.liveStatus === 1) parts.push("直播中");
	else if (runtime.liveStatus === 0) parts.push("未开播（收不到礼物）");
	if (runtime.paused) parts.push("已暂停");
	const minutes = Math.round(runtime.remainingMs / 60_000);
	parts.push(minutes >= 0 ? `剩余 ${minutes} 分钟` : `加班 ${-minutes} 分钟`);
	return parts.join(" · ");
});

/** 把服务器返回的配置灌进表单 */
function applyServerConfig(config: ServerConfig): void {
	roomId = String(config.roomId ?? "");
	initialMinutes = Number(config.initialMinutes) || 120;
	cnyToMinutes = Number(config.cnyToMinutes) || 0;
	ignoreSilver = config.ignoreSilverGifts !== false;
	guardCaptain = Number(config.guards?.[1]) || 0;
	guardAdmiral = Number(config.guards?.[2]) || 0;
	guardGovernor = Number(config.guards?.[3]) || 0;
	perGift = Number(config.caps?.perGiftMinutes) || 0;
	perUser = Number(config.caps?.perUserPerMinute) || 0;
	totalCap = Number(config.caps?.totalMinutes) || 0;
	cookieSet = config.cookieSet === true;
	cookieInput = "";
	clearCookie = false;
	const rows: GiftRow[] = [];
	for (const [name, minutes] of Object.entries(config.gifts ?? {})) {
		rows.push(makeGiftRow(name, Number(minutes) || 0));
	}
	giftRows = rows.length > 0 ? rows : [makeGiftRow("", 1)];
}

function makeGiftRow(name: string, minutes: number): GiftRow {
	rowSeq += 1;
	return { id: rowSeq, name, minutes };
}

/** 把「最近收到的礼物」里的某一条加进礼物表（已存在就只提示） */
function addGiftFromRecent(gift: RecentGift): void {
	const name = gift.giftName.trim();
	if (!name) return;
	if (giftRows.some((row) => row.name.trim() === name)) {
		saveMsg = `礼物表里已经有「${name}」了`;
		return;
	}
	giftRows = [...giftRows, makeGiftRow(name, 1)];
	saveMsg = `已把「${name}」加进礼物表，改好分钟数后点「保存到服务器」`;
}

/** 把某个礼物设成 0 分钟（等于忽略） */
function ignoreRecentGift(gift: RecentGift): void {
	const name = gift.giftName.trim();
	if (!name) return;
	const exists = giftRows.find((row) => row.name.trim() === name);
	if (exists) {
		exists.minutes = 0;
	} else {
		giftRows = [...giftRows, makeGiftRow(name, 0)];
	}
	saveMsg = `已把「${name}」设为 0 分钟，保存后生效`;
}

function applyRecent(list: unknown): void {
	if (Array.isArray(list)) recentGifts = list as RecentGift[];
}

async function refreshRecent(): Promise<void> {
	if (!token) return;
	try {
		const res = await fetch(`${apiBase}/admin/config`, {
			headers: { authorization: `Bearer ${token}` },
			cache: "no-store",
		});
		if (!res.ok) return;
		const data = (await res.json()) as { recentGifts?: RecentGift[] };
		applyRecent(data.recentGifts);
	} catch {
		// 拉不到就保持旧列表
	}
}

function applyAuthSuccess(
	nextToken: string,
	config: ServerConfig | undefined,
	info: RuntimeInfo | undefined,
): void {
	if (config) applyServerConfig(config);
	if (info) runtime = info;
	token = nextToken;
	loggedIn = true;
	try {
		sessionStorage.setItem("live-timer-token", nextToken);
	} catch {
		// 隐私模式写不了也无所谓
	}
	void refreshRuntime();
	void refreshRecent();
}

async function login(): Promise<void> {
	if (loginBusy) return;
	loginBusy = true;
	loginError = "";
	saveMsg = "";
	saveError = "";
	try {
		const res = await fetch(`${apiBase}/admin/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: loginPassword }),
		});
		const data = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			token?: string;
			config?: ServerConfig;
			runtime?: RuntimeInfo;
			error?: string;
		};
		if (!res.ok || !data.ok || !data.token) {
			throw new Error(data.error ?? `HTTP ${res.status}`);
		}
		loginPassword = "";
		applyRecent(data.recentGifts);
		applyAuthSuccess(data.token, data.config, data.runtime);
	} catch (err) {
		loginError = err instanceof Error ? err.message : String(err);
	} finally {
		loginBusy = false;
	}
}

async function restoreSession(): Promise<void> {
	let saved = "";
	try {
		saved = sessionStorage.getItem("live-timer-token") ?? "";
	} catch {
		saved = "";
	}
	if (!saved) return;
	try {
		const res = await fetch(`${apiBase}/admin/config`, {
			headers: { authorization: `Bearer ${saved}` },
			cache: "no-store",
		});
		if (!res.ok) return;
		const data = (await res.json()) as {
			config?: ServerConfig;
			runtime?: RuntimeInfo;
		};
		applyRecent(data.recentGifts);
		applyAuthSuccess(saved, data.config, data.runtime);
	} catch {
		// 拿不到就当作没登录
	}
}

async function reloadFromServer(): Promise<void> {
	saveMsg = "";
	saveError = "";
	try {
		const res = await fetch(`${apiBase}/admin/config`, {
			headers: { authorization: `Bearer ${token}` },
			cache: "no-store",
		});
		if (res.status === 401) {
			logout();
			throw new Error("登录已过期，请重新输入口令");
		}
		const data = (await res.json()) as {
			ok?: boolean;
			config?: ServerConfig;
			runtime?: RuntimeInfo;
			error?: string;
		};
		if (!res.ok || !data.ok)
			throw new Error(data.error ?? `HTTP ${res.status}`);
		if (data.config) applyServerConfig(data.config);
		if (data.runtime) runtime = data.runtime;
		saveMsg = "已从服务器重新加载";
	} catch (err) {
		saveError = err instanceof Error ? err.message : String(err);
	}
}

async function saveToServer(): Promise<void> {
	if (saveBusy) return;
	saveBusy = true;
	saveMsg = "";
	saveError = "";
	try {
		const payload: {
			config: Record<string, unknown>;
		} = {
			config: {
				roomId: Number(roomId) || 0,
				initialMinutes: Number(initialMinutes) || 0,
				cnyToMinutes: Number(cnyToMinutes) || 0,
				ignoreSilverGifts: ignoreSilver,
				gifts: giftMap,
				guards: {
					1: Number(guardCaptain) || 0,
					2: Number(guardAdmiral) || 0,
					3: Number(guardGovernor) || 0,
				},
				caps: {
					perGiftMinutes: Number(perGift) || 0,
					perUserPerMinute: Number(perUser) || 0,
					totalMinutes: Number(totalCap) || 0,
				},
			},
		};
		// cookie 只写不读：留空 = 不改；点「清空」= 传空串；填了 = 覆盖
		if (clearCookie) {
			payload.config.cookie = "";
		} else if (cookieInput.trim()) {
			payload.config.cookie = cookieInput.trim();
		}
		const res = await fetch(`${apiBase}/admin/config`, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(payload),
		});
		const data = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			config?: ServerConfig;
			runtime?: RuntimeInfo;
			error?: string;
		};
		if (res.status === 401) {
			logout();
			throw new Error(data.error ?? "登录已过期，请重新输入口令");
		}
		if (!res.ok || !data.ok)
			throw new Error(data.error ?? `HTTP ${res.status}`);
		if (data.config) applyServerConfig(data.config);
		if (data.runtime) runtime = data.runtime;
		saveMsg = "已保存；礼物规则立即生效，开局时长在下次「重新开局」时生效";
	} catch (err) {
		saveError = err instanceof Error ? err.message : String(err);
	} finally {
		saveBusy = false;
	}
}

/** 时间控制：重新开局 / 暂停 / 继续 / 加减时，用登录态调服务端 /control */
async function control(action: string, minutes?: number): Promise<void> {
	if (ctlBusy) return;
	ctlBusy = true;
	ctlBad = false;
	ctlMsg = "";
	try {
		const res = await fetch(`${apiBase}/control`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ action, minutes }),
		});
		const data = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			error?: string;
			state?: Partial<RuntimeInfo>;
		};
		if (res.status === 401 || res.status === 403) {
			logout();
			throw new Error(data.error ?? "登录已过期，请重新输入口令");
		}
		if (!res.ok || !data.ok)
			throw new Error(data.error ?? `HTTP ${res.status}`);
		if (data.state) {
			runtime = {
				roomId: Number(data.state.roomId) || 0,
				connected: Boolean(data.state.connected),
				reason: String(data.state.reason ?? ""),
				remainingMs: Number(data.state.remainingMs) || 0,
				paused: Boolean(data.state.paused),
				giftCount: Number(data.state.giftCount) || 0,
				addedMs: Number(data.state.addedMs) || 0,
				liveStatus:
					data.state.liveStatus === undefined || data.state.liveStatus === null
						? null
						: Number(data.state.liveStatus),
				authOk: data.state.authOk ?? null,
				authReason: String(data.state.authReason ?? ""),
			};
		}
		if (action === "start") ctlMsg = "已重新开局";
		else if (action === "pause") ctlMsg = "已暂停";
		else if (action === "resume") ctlMsg = "已继续";
		else ctlMsg = `已${action === "add" ? "加" : "减"} ${minutes ?? 0} 分钟`;
	} catch (err) {
		ctlBad = true;
		ctlMsg = err instanceof Error ? err.message : String(err);
	} finally {
		ctlBusy = false;
	}
}

async function changePassword(): Promise<void> {
	if (pwdBusy) return;
	pwdBad = false;
	pwdMsg = "";
	if (newPwd !== confirmPwd) {
		pwdBad = true;
		pwdMsg = "两次输入的新口令不一致";
		return;
	}
	if (newPwd.length < 6) {
		pwdBad = true;
		pwdMsg = "新口令至少 6 位";
		return;
	}
	pwdBusy = true;
	try {
		const res = await fetch(`${apiBase}/admin/password`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				currentPassword: currentPwd,
				newPassword: newPwd,
			}),
		});
		const data = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			token?: string;
			error?: string;
		};
		if (!res.ok || !data.ok) {
			if (res.status === 401) logout();
			throw new Error(data.error ?? `HTTP ${res.status}`);
		}
		if (data.token) {
			token = data.token;
			try {
				sessionStorage.setItem("live-timer-token", data.token);
			} catch {
				// ignore
			}
		}
		currentPwd = "";
		newPwd = "";
		confirmPwd = "";
		pwdMsg = "已更新，下次登录用新口令";
	} catch (err) {
		pwdBad = true;
		pwdMsg = err instanceof Error ? err.message : String(err);
	} finally {
		pwdBusy = false;
	}
}

function logout(): void {
	token = "";
	loggedIn = false;
	saveMsg = "";
	saveError = "";
	try {
		sessionStorage.removeItem("live-timer-token");
	} catch {
		// ignore
	}
}

async function refreshRuntime(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/state`, { cache: "no-store" });
		if (!res.ok) return;
		const data = (await res.json()) as Partial<RuntimeInfo>;
		runtime = {
			roomId: Number(data.roomId) || 0,
			connected: Boolean(data.connected),
			reason: String(data.reason ?? ""),
			remainingMs: Number(data.remainingMs) || 0,
			paused: Boolean(data.paused),
			giftCount: Number(data.giftCount) || 0,
			addedMs: Number(data.addedMs) || 0,
			liveStatus:
				data.liveStatus === undefined || data.liveStatus === null
					? null
					: Number(data.liveStatus),
			authOk: data.authOk ?? null,
			authReason: String(data.authReason ?? ""),
		};
	} catch {
		// 拉不到就保持上一次的状态
	}
}

onMount(() => {
	origin = window.location.origin;
	// 本地调试可以 ?api=http://127.0.0.1:8848 指向本机服务；线上不传就用 nginx 反代路径
	const override = new URLSearchParams(window.location.search).get("api");
	if (override) apiBase = override.replace(/\/$/, "");
	void restoreSession();
	const timer = window.setInterval(() => {
		if (loggedIn) {
			void refreshRuntime();
			void refreshRecent();
		}
	}, 10_000);
	return () => window.clearInterval(timer);
});

/** 样式参数 → URL 查询串（默认值不写进 URL，地址保持干净） */
const styleQuery = $derived.by(() => {
	const params = new URLSearchParams();
	if (pos !== "bl") params.set("pos", pos);
	if (scale !== 1) params.set("scale", String(scale));
	if (label.trim() && label.trim() !== DEFAULT_LABEL)
		params.set("label", label.trim());
	if (accent.toLowerCase() !== "#fb7299") params.set("accent", accent);
	if (theme !== "dark") params.set("theme", theme);
	if (!showGifts) params.set("gifts", "0");
	if (!showBar) params.set("bar", "0");
	if (!overtime) params.set("overtime", "0");
	return params.toString();
});

const obsUrl = $derived(
	`${origin}${OVERLAY_PATH}${styleQuery ? `?${styleQuery}` : ""}`,
);

// 预览地址跟样式联动，但打字时别每敲一下就重载 iframe
$effect(() => {
	const params = new URLSearchParams(styleQuery);
	params.set("mock", "1");
	params.set("bg", "1");
	params.set("mockMinutes", String(initialMinutes));
	const next = `${OVERLAY_PATH}?${params.toString()}`;
	const timer = setTimeout(() => {
		previewUrl = next;
	}, 350);
	return () => clearTimeout(timer);
});

const giftMap = $derived.by(() => {
	const map: Record<string, number> = {};
	for (const row of giftRows) {
		const name = row.name.trim();
		if (!name) continue;
		map[name] = Number(row.minutes) || 0;
	}
	return map;
});

const configJson = $derived(
	JSON.stringify(
		{
			roomId: Number(roomId) || 0,
			initialMinutes: Number(initialMinutes) || 0,
			cnyToMinutes: Number(cnyToMinutes) || 0,
			ignoreSilverGifts: ignoreSilver,
			gifts: giftMap,
			guards: {
				1: Number(guardCaptain) || 0,
				2: Number(guardAdmiral) || 0,
				3: Number(guardGovernor) || 0,
			},
			caps: {
				perGiftMinutes: Number(perGift) || 0,
				perUserPerMinute: Number(perUser) || 0,
				totalMinutes: Number(totalCap) || 0,
			},
		},
		null,
		2,
	),
);

/** 100 元能换多久，给个直观参照 */
const hundredYuan = $derived(formatSpan(100 * Number(cnyToMinutes) * 60_000));

function formatSpan(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function addRow(): void {
	giftRows = [...giftRows, makeGiftRow("", 1)];
}

function removeRow(id: number): void {
	giftRows = giftRows.filter((row) => row.id !== id);
}

function fallbackCopy(text: string): boolean {
	const area = document.createElement("textarea");
	area.value = text;
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	document.body.removeChild(area);
	return ok;
}

async function copy(text: string, key: string): Promise<void> {
	let ok = false;
	try {
		await navigator.clipboard.writeText(text);
		ok = true;
	} catch {
		ok = fallbackCopy(text);
	}
	copied = ok ? key : "";
	if (ok) {
		setTimeout(() => {
			if (copied === key) copied = "";
		}, 1800);
	}
}

function downloadConfig(): void {
	const blob = new Blob([`${configJson}\n`], {
		type: "application/json;charset=utf-8",
	});
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = "live-timer-tunables.json";
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
</script>

<div class="configurator">
	{#if loggedIn && runtime?.authOk === false}
		<div class="auth-alert">
			<strong>B 站登录已失效，现在收不到礼物</strong>
			<span>{runtime.authReason || "cookie 已过期"}</span>
			<span class="auth-alert-tip">
				→ 在下面「登录 Cookie」里重新填一条 SESSDATA 即可，保存后自动重连。
			</span>
		</div>
	{/if}

	{#if loggedIn}
		<div class="savebar">
			<span class="pill" class:off={!runtime?.connected}>{runtimeLabel}</span>
			<div class="savebar-actions">
				<button type="button" class="ghost" onclick={reloadFromServer} disabled={saveBusy}>
					重新加载
				</button>
				<button type="button" class="ghost" onclick={logout} disabled={saveBusy}>退出</button>
				<button type="button" class="primary" onclick={saveToServer} disabled={saveBusy}>
					{saveBusy ? "保存中…" : "保存到服务器"}
				</button>
			</div>
		</div>
		{#if saveMsg}<p class="ok">{saveMsg}</p>{/if}
		{#if saveError}<p class="err">{saveError}</p>{/if}
	{/if}

	<div class="panels">
		<div class="form">
			{#if loggedIn}
			<section class="panel">
				<h3>时间控制</h3>
				<p class="hint">
					当前：<strong>{runtimeLabel}</strong>。点按钮即时生效，不用刷新。
					「重新开局」会用下面设置的「开局时长」。
				</p>
				<div class="ctl-grid">
					<button type="button" class="primary" onclick={() => control("start")} disabled={ctlBusy}>
						重新开局（{initialMinutes} 分钟）
					</button>
					{#if runtime?.paused}
						<button type="button" class="ghost" onclick={() => control("resume")} disabled={ctlBusy}>
							继续
						</button>
					{:else}
						<button type="button" class="ghost" onclick={() => control("pause")} disabled={ctlBusy}>
							暂停
						</button>
					{/if}
					<button type="button" class="ghost" onclick={() => control("add", 1)} disabled={ctlBusy}>+1 分</button>
					<button type="button" class="ghost" onclick={() => control("add", 5)} disabled={ctlBusy}>+5 分</button>
					<button type="button" class="ghost" onclick={() => control("sub", 1)} disabled={ctlBusy}>−1 分</button>
					<button type="button" class="ghost" onclick={() => control("sub", 5)} disabled={ctlBusy}>−5 分</button>
				</div>
				<div class="ctl-custom">
					<input type="number" min="1" max="600" bind:value={customMinutes} />
					<span class="unit">分钟</span>
					<button type="button" class="ghost" onclick={() => control("add", Number(customMinutes))} disabled={ctlBusy}>
						加
					</button>
					<button type="button" class="ghost" onclick={() => control("sub", Number(customMinutes))} disabled={ctlBusy}>
						减
					</button>
					{#if ctlMsg}<span class="ctl-msg" class:bad={ctlBad}>{ctlMsg}</span>{/if}
				</div>
			</section>

			<section class="panel">
				<h3>直播与时长</h3>
				<div class="grid">
					<label>
						<span>直播间号</span>
						<input type="text" bind:value={roomId} inputmode="numeric" />
					</label>
					<label>
						<span>开局时长（分钟）</span>
						<input type="number" min="1" max="1440" bind:value={initialMinutes} />
					</label>
					<label>
						<span>1 元 = 多少分钟</span>
						<input type="number" min="0" step="0.1" bind:value={cnyToMinutes} />
					</label>
					<label class="check">
						<input type="checkbox" bind:checked={ignoreSilver} />
						<span>免费礼物（银瓜子）不加时</span>
					</label>
				</div>
				<p class="hint">
					按当前设置，100 元 ≈ <strong>{hundredYuan}</strong>。没命中下面礼物表的礼物一律按这个比例算。
				</p>

				<div class="field cookie-field">
					<span class="field-name">
						登录 Cookie
						<em class:off={!cookieSet}>{cookieSet ? "已设置" : "未设置"}</em>
					</span>
					<div class="cookie-row">
						<input
							type="password"
							placeholder={cookieSet ? "已设置，留空表示不改" : "SESSDATA=xxxx; bili_jct=yyyy"}
							bind:value={cookieInput}
							autocomplete="off"
							disabled={clearCookie}
						/>
						<button
							type="button"
							class="ghost"
							onclick={() => {
								clearCookie = !clearCookie;
								cookieInput = "";
							}}
						>
							{clearCookie ? "取消清空" : "清空"}
						</button>
					</div>
					<p class="hint">
						不带 cookie 时是匿名连接，B 站<b>只推全站广播</b>，房间里的弹幕/礼物收不到。
						从浏览器 F12 → Application → Cookies → bilibili.com 复制整条（重点含 <code>SESSDATA</code>），
						保存后会自动以你的 uid 重连。这里只写不读，存到服务器上不会再显示出来。
					</p>
				</div>
			</section>

			<section class="panel">
				<h3>礼物表</h3>
				<p class="hint">名字要和弹幕里推的 <code>giftName</code> 一字不差；<strong>0</strong> = 不加不减，<strong>负数</strong> = 减时（如 <code>-0.1</code>）。</p>
				<div class="rows">
					{#each giftRows as row (row.id)}
						<div class="row">
							<input type="text" placeholder="礼物名，如 小花花" bind:value={row.name} />
							<input class="minutes" type="number" min="-1440" step="0.1" bind:value={row.minutes} />
							<span class="unit">分钟</span>
							<button
								type="button"
								class="ghost danger"
								title="删掉这一行"
								onclick={() => removeRow(row.id)}
								disabled={giftRows.length <= 1}
							>
								×
							</button>
						</div>
					{/each}
				</div>
				<button type="button" class="ghost" onclick={addRow}>+ 加一行</button>
			</section>

			<section class="panel">
				<h3>最近收到的礼物</h3>
				<p class="hint">
					这是直播间接到的原始礼物（含没加时的），显示 B 站推过来的真实 <code>giftName</code> 和 <code>giftId</code>。
					点「加进礼物表」按名称填入上方表格，再改分钟数；点「设 0」等于忽略它。每 15 秒刷新。
				</p>
				{#if recentGifts.length === 0}
					<p class="hint">还没有记录。开播后有人送礼就会出现。</p>
				{:else}
					<ul class="recent-gifts">
						{#each recentGifts as gift (gift.at + "-" + gift.giftId + "-" + gift.num)}
							<li class="recent-gift">
								<div class="rg-main">
									<span class="rg-name">{gift.giftName}<em>×{gift.num}</em></span>
									<span class="rg-meta">
										id {gift.giftId} · {gift.coinType || "?"} · 单价 {gift.price} ·
										<span class:rg-ok={gift.applied} class:rg-no={!gift.applied}>
											{gift.reason}{gift.applied ? ` ${gift.ms >= 0 ? "+" : ""}${(gift.ms / 60000).toFixed(2)} 分` : ""}
										</span>
									</span>
									<span class="rg-user">{gift.uname}</span>
								</div>
								<div class="rg-actions">
									<button type="button" class="ghost" onclick={() => addGiftFromRecent(gift)}>
										加进礼物表
									</button>
									<button type="button" class="ghost" onclick={() => ignoreRecentGift(gift)}>设 0</button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="panel">
				<h3>大航海</h3>
				<div class="grid three">
					<label>
						<span>舰长</span>
						<input type="number" min="0" bind:value={guardCaptain} />
					</label>
					<label>
						<span>提督</span>
						<input type="number" min="0" bind:value={guardAdmiral} />
					</label>
					<label>
						<span>总督</span>
						<input type="number" min="0" bind:value={guardGovernor} />
					</label>
				</div>
			</section>

			<section class="panel">
				<h3>上限保护</h3>
				<div class="grid three">
					<label>
						<span>单次礼物</span>
						<input type="number" min="0" bind:value={perGift} />
					</label>
					<label>
						<span>单人/分钟</span>
						<input type="number" min="0" bind:value={perUser} />
					</label>
					<label>
						<span>整场总量</span>
						<input type="number" min="0" bind:value={totalCap} />
					</label>
				</div>
				<p class="hint">单位都是分钟；填 0 表示不限制。整场总量建议一定要设，不然一场能被加到天亮。</p>
			</section>

			<section class="panel">
				<details class="pwd">
					<summary>修改网页登录口令</summary>
					<p class="hint">
						改完会同时更换签名密钥：其它设备/浏览器上的登录立刻失效，当前这个页面会自动续上新令牌。
					</p>
					<div class="pwd-form">
						<label>
							<span>当前口令</span>
							<input type="password" bind:value={currentPwd} autocomplete="current-password" />
						</label>
						<label>
							<span>新口令（至少 6 位）</span>
							<input type="password" bind:value={newPwd} autocomplete="new-password" />
						</label>
						<label>
							<span>再输一次</span>
							<input type="password" bind:value={confirmPwd} autocomplete="new-password" />
						</label>
					</div>
					<div class="pwd-actions">
						<button type="button" class="primary" onclick={changePassword} disabled={pwdBusy}>
							{pwdBusy ? "提交中…" : "保存新口令"}
						</button>
						{#if pwdMsg}<span class="pwd-msg" class:bad={pwdBad}>{pwdMsg}</span>{/if}
					</div>
				</details>
			</section>
			{:else}
			<section class="panel login">
				<h3>需要口令</h3>
				<p class="hint">
					这个表单会直接改服务器上的 <code>/etc/live-timer/config.json</code> 并立刻生效，所以要先验证身份。
					口令只以 scrypt 哈希形式存在服务器上，网页这边不保存明文。
				</p>
				<form
					class="login-form"
					onsubmit={(event) => {
						event.preventDefault();
						void login();
					}}
				>
					<input
						type="password"
						placeholder="网页口令"
						bind:value={loginPassword}
						autocomplete="current-password"
						disabled={loginBusy}
					/>
					<button type="submit" class="primary" disabled={loginBusy}>
						{loginBusy ? "验证中…" : "进入编辑"}
					</button>
				</form>
				{#if loginError}<p class="err">{loginError}</p>{/if}
				<p class="hint">
					口令在服务器上设置：<code>sudo node /usr/local/bin/live-timer.mjs --set-password</code>
					（不给参数会随机生成并打印）。连续输错 5 次会锁 5 分钟。
				</p>
			</section>
			{/if}

			<section class="panel">
				<h3>叠层样式</h3>
				<div class="field">
					<span class="field-name">停靠位置</span>
					<div class="segmented">
						{#each POSITIONS as item (item.value)}
							<button
								type="button"
								class:active={pos === item.value}
								onclick={() => (pos = item.value)}
							>
								{item.name}
							</button>
						{/each}
					</div>
				</div>

				<div class="field">
					<span class="field-name">缩放 <em>{scale.toFixed(2)}×</em></span>
					<input type="range" min="0.6" max="2" step="0.05" bind:value={scale} />
				</div>

				<div class="grid">
					<label>
						<span>顶部文案</span>
						<input type="text" bind:value={label} maxlength="20" />
					</label>
					<label>
						<span>主色</span>
						<input type="color" bind:value={accent} />
					</label>
				</div>

				<div class="toggles">
					<label class="check"><input type="checkbox" bind:checked={showGifts} /><span>礼物飘屏</span></label>
					<label class="check"><input type="checkbox" bind:checked={showBar} /><span>进度条与明细</span></label>
					<label class="check"><input type="checkbox" bind:checked={overtime} /><span>超时显示加班</span></label>
					<label class="check">
						<input
							type="checkbox"
							checked={theme === "light"}
							onchange={(event) => (theme = event.currentTarget.checked ? "light" : "dark")}
						/>
						<span>浅色主题</span>
					</label>
				</div>
			</section>
		</div>

		<aside class="side">
			<section class="panel sticky">
				<h3>预览</h3>
				<div class="preview">
					<iframe title="叠层预览" src={previewUrl} sandbox="allow-scripts allow-same-origin"></iframe>
				</div>
				<p class="hint">预览用的是本地假数据（每秒走字、每 6 秒飘一条假礼物），不影响线上。</p>

				<h3 class="gap">OBS 地址</h3>
				<div class="output">
					<textarea readonly rows="2">{obsUrl}</textarea>
					<div class="output-actions">
						<button type="button" class="primary" onclick={() => copy(obsUrl, "obs")}>
							{copied === "obs" ? "已复制" : "复制地址"}
						</button>
						<a class="ghost" href={obsUrl} target="_blank" rel="noreferrer noopener">新窗口打开</a>
					</div>
				</div>
				<p class="hint">OBS → 来源 → 浏览器源，宽高填 1920×1080，页面背景本身就是透明的。</p>

				<details class="advanced">
					<summary>手动编辑（高级）</summary>
					<p class="hint">
						登录后左边的表单会直接改服务器并保存;这一块是给「只改本地草稿 / 手动改配置文件」准备的。
					</p>
					<div class="output">
						<textarea readonly rows="10">{configJson}</textarea>
						<div class="output-actions">
							<button type="button" class="primary" onclick={() => copy(configJson, "json")}>
								{copied === "json" ? "已复制" : "复制配置"}
							</button>
							<button type="button" class="ghost" onclick={downloadConfig}>下载</button>
						</div>
					</div>
					<p class="hint warn">
						这是<strong>片段</strong>：手动合并进 <code>/etc/live-timer/config.json</code> 时，
						别整份覆盖 —— <code>outFile</code>、<code>stateFile</code>、<code>adminToken</code> 要保留服务器上的原值。
						改完 <code>sudo systemctl restart live-timer</code>。
					</p>
				</details>
			</section>
		</aside>
	</div>
</div>

<style>
	.configurator {
		width: 100%;
	}

	.auth-alert {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.75rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid #f43f5e;
		border-left-width: 4px;
		border-radius: 0.6rem;
		background-color: rgba(244, 63, 94, 0.12);
		color: #b91c1c;
		font-size: 0.8rem;
	}

	.auth-alert strong {
		font-size: 0.86rem;
	}

	.auth-alert-tip {
		opacity: 0.8;
	}

	.savebar {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.8rem;
		background-color: var(--card-bg);
	}

	.pill {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		background-color: var(--btn-plain-bg-hover);
		color: var(--primary);
		font-size: 0.75rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.pill.off {
		color: #f59e0b;
	}

	.savebar-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.ok {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.7rem;
		border-left: 3px solid #22c55e;
		border-radius: 0.4rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font-size: 0.78rem;
	}

	.err {
		margin: 0.55rem 0 0.75rem;
		padding: 0.5rem 0.7rem;
		border-left: 3px solid #f43f5e;
		border-radius: 0.4rem;
		background-color: var(--btn-regular-bg);
		color: #f43f5e;
		font-size: 0.78rem;
	}

	.login-form {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}

	.login-form input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font: inherit;
		font-size: 0.85rem;
	}

	.advanced {
		margin-top: 1.15rem;
		padding-top: 0.8rem;
		border-top: 1px solid var(--line-divider);
	}

	.advanced summary {
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--content-meta);
	}

	.advanced summary:hover {
		color: var(--primary);
	}

	.pwd summary {
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--deep-text);
	}

	.pwd summary:hover {
		color: var(--primary);
	}

	.pwd-form {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.6rem;
		margin-top: 0.6rem;
	}

	@media (max-width: 720px) {
		.pwd-form {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.pwd-form label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--content-meta);
	}

	.pwd-form label > span {
		font-weight: 600;
	}

	.pwd-form input {
		width: 100%;
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font: inherit;
		font-size: 0.85rem;
		box-sizing: border-box;
	}

	.pwd-actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.7rem;
	}

	.pwd-msg {
		font-size: 0.76rem;
		color: #22c55e;
	}

	.pwd-msg.bad {
		color: #f43f5e;
	}

	.ctl-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
		gap: 0.5rem;
		margin-top: 0.7rem;
	}

	.ctl-grid button {
		justify-content: center;
	}

	.ctl-custom {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
	}

	.ctl-custom input {
		width: 5.5rem;
		padding: 0.35rem 0.55rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.5rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font: inherit;
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
	}

	.unit {
		font-size: 0.74rem;
		color: var(--content-meta);
	}

	.ctl-msg {
		font-size: 0.76rem;
		color: #22c55e;
	}

	.ctl-msg.bad {
		color: #f43f5e;
	}

	.recent-gifts {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin: 0.2rem 0 0;
		padding: 0;
		list-style: none;
		max-height: 16rem;
		overflow-y: auto;
	}

	.recent-gift {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
	}

	.rg-main {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.rg-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--deep-text);
	}

	.rg-name em {
		font-style: normal;
		opacity: 0.6;
		margin-left: 0.25rem;
	}

	.rg-meta {
		font-size: 0.72rem;
		color: var(--content-meta);
		font-variant-numeric: tabular-nums;
	}

	.rg-ok {
		color: #22c55e;
	}

	.rg-no {
		color: #f59e0b;
	}

	.rg-user {
		font-size: 0.7rem;
		color: var(--content-meta);
		opacity: 0.75;
	}

	.rg-actions {
		display: flex;
		gap: 0.35rem;
		flex-shrink: 0;
	}
	.cookie-field {
		margin-top: 0.9rem;
		padding-top: 0.8rem;
		border-top: 1px dashed var(--line-divider);
	}

	.cookie-field .field-name em.off {
		color: #f59e0b;
	}

	.cookie-row {
		display: flex;
		gap: 0.5rem;
	}

	.cookie-row input {
		flex: 1;
		min-width: 0;
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font: inherit;
		font-size: 0.82rem;
	}

	.panels {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}

	@media (max-width: 1100px) {
		.panels {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}

	.panel {
		padding: 1rem 1.1rem 1.15rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.9rem;
		background-color: var(--card-bg);
		min-width: 0;
	}

	.side .sticky {
		position: sticky;
		top: 1rem;
	}

	h3 {
		margin: 0 0 0.75rem;
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--deep-text);
	}

	h3.gap {
		margin-top: 1.15rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.7rem 0.9rem;
	}

	.grid.three {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--content-meta);
		min-width: 0;
	}

	label > span {
		font-weight: 600;
	}

	input[type="text"],
	input[type="number"] {
		width: 100%;
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font: inherit;
		font-size: 0.85rem;
		box-sizing: border-box;
	}

	input[type="number"] {
		font-variant-numeric: tabular-nums;
	}

	input[type="color"] {
		width: 100%;
		height: 2.1rem;
		padding: 0.15rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		cursor: pointer;
	}

	input[type="range"] {
		width: 100%;
		accent-color: var(--primary);
	}

	input:focus-visible,
	button:focus-visible,
	textarea:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.82rem;
		color: var(--deep-text);
		cursor: pointer;
	}

	.check input {
		accent-color: var(--primary);
		width: 1rem;
		height: 1rem;
		cursor: pointer;
	}

	.field {
		margin-bottom: 0.85rem;
	}

	.field-name {
		display: block;
		margin-bottom: 0.35rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--content-meta);
	}

	.field-name em {
		font-style: normal;
		color: var(--primary);
		font-variant-numeric: tabular-nums;
	}

	.segmented {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.35rem;
	}

	.segmented button {
		padding: 0.35rem 0;
		border: 1px solid var(--line-divider);
		border-radius: 0.5rem;
		background-color: var(--btn-regular-bg);
		color: var(--content-meta);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
		transition:
			color 0.15s,
			border-color 0.15s,
			background-color 0.15s;
	}

	.segmented button:hover {
		color: var(--primary);
	}

	.segmented button.active {
		border-color: var(--primary);
		color: var(--primary);
		background-color: var(--btn-plain-bg-hover);
		font-weight: 700;
	}

	.toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1.2rem;
		margin-top: 0.4rem;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin-bottom: 0.6rem;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 5.5rem auto auto;
		align-items: center;
		gap: 0.45rem;
	}

	.row input {
		min-width: 0;
	}

	.unit {
		font-size: 0.72rem;
		color: var(--content-meta);
	}

	button {
		font: inherit;
		cursor: pointer;
	}

	.ghost {
		padding: 0.35rem 0.7rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.5rem;
		background-color: transparent;
		color: var(--content-meta);
		font-size: 0.78rem;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.ghost:hover:not(:disabled) {
		color: var(--primary);
		border-color: var(--primary);
	}

	.ghost:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ghost.danger {
		padding: 0.35rem 0.55rem;
		line-height: 1;
	}

	.ghost.danger:hover {
		color: #f43f5e;
		border-color: #f43f5e;
	}

	.primary {
		padding: 0.35rem 0.9rem;
		border: 1px solid var(--primary);
		border-radius: 0.5rem;
		background-color: var(--primary);
		color: #fff;
		font-size: 0.78rem;
		font-weight: 600;
		transition: opacity 0.15s;
	}

	.primary:hover {
		opacity: 0.88;
	}

	.preview {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 0.75rem;
		overflow: hidden;
		background:
			radial-gradient(circle at 20% 20%, #1e2233 0%, #0b0d14 60%, #05060a 100%);
	}

	.preview iframe {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
	}

	.output textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.6rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-size: 0.74rem;
		line-height: 1.55;
		resize: vertical;
	}

	.output-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.hint {
		margin: 0.6rem 0 0;
		font-size: 0.74rem;
		line-height: 1.65;
		color: var(--content-meta);
	}

	.hint code {
		padding: 0.05rem 0.3rem;
		border-radius: 0.3rem;
		background-color: var(--btn-regular-bg);
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.72rem;
	}

	.hint strong {
		color: var(--deep-text);
	}

	.hint.warn {
		padding: 0.55rem 0.7rem;
		border-left: 3px solid var(--primary);
		border-radius: 0.4rem;
		background-color: var(--btn-plain-bg-hover);
	}
</style>
