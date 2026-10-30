<script lang="ts">
/**
 * 直播礼物加时 · 倒计时叠层
 *
 * 数据源：服务端每秒刷新的 /api/live-timer.json（deploy/server/live-timer）。
 * 页面只做两件事：把「结束时间戳」换算成剩余时间，把新礼物飘出来。
 *
 * URL 参数（都可以叠着用）：
 *   pos=bl|bc|br|tl|tc|tr  停靠位置（默认 bl 左下）
 *   scale=1.2              整体缩放
 *   label=距下播还有        顶部文案
 *   accent=%23FB7299       主色
 *   theme=dark|light       配色
 *   gifts=0                不显示礼物飘屏
 *   rules=0                不显示倒计时上方的礼物价目（默认显示）
 *   bar=0                  不显示进度条和明细
 *   overtime=0             超时后停在 00:00，不显示加班
 *   bg=1                   给页面加个深色底（自己调样式时看得清）
 *   admin=1                显示控制台（别放进 OBS 源里）
 *   mock=1                 预览模式：本地造数据 + 定时飘假礼物，不连服务端
 *   mockMinutes=120        预览模式下的剩余分钟数
 *   api=/live-timer-api    控制接口前缀（默认算出来的那个）
 */
import { onMount } from "svelte";

interface GiftEvent {
	kind?: string;
	user: string;
	label: string;
	deltaMs: number;
	at: number;
}

/** 服务端由礼物表算出的价目：minutes 是「每一个礼物」的加减分钟数 */
interface GiftRule {
	name: string;
	minutes: number;
}

interface Snapshot {
	v: number;
	now: number;
	updatedAt: string;
	roomId: number;
	deadline: number;
	paused: boolean;
	pausedRemainingMs: number;
	remainingMs: number;
	initialMs: number;
	addedMs: number;
	removedMs: number;
	giftCount: number;
	recent: GiftEvent[];
	lastGift: GiftEvent | null;
	rules?: GiftRule[];
	connected?: boolean;
	reason?: string;
}

interface Toast extends GiftEvent {
	id: number;
}

const BASE = import.meta.env.BASE_URL;

const DEFAULT_LABEL = "距下播还有";
const TOAST_LIFETIME = 7000;

/** 礼物小图标：命中就用图，没命中就只显示文字，不会留空框 */
const GIFT_ICONS: Record<string, string> = {
	人气票: `${BASE}live-timer/gift/renqi-piao.webp`,
	粉丝团灯牌: `${BASE}live-timer/gift/fans-medal.webp`,
};

/** 预览模式没有服务端，拿一份示例价目撑住版式 */
const MOCK_RULES: GiftRule[] = [
	{ name: "人气票", minutes: 0.1 },
	{ name: "粉丝团灯牌", minutes: -0.1 },
];

let snap = $state<Snapshot | null>(null);
/** 服务端时钟 - 本机时钟，用来消掉两边的时间差 */
let skew = $state(0);
let nowMs = $state(Date.now());
let lastOkAt = $state(0);
let failure = $state("");

let scale = $state(1);
let pos = $state("bl");
let label = $state(DEFAULT_LABEL);
let accent = $state("#FB7299");
let theme = $state("dark");
let showGifts = $state(true);
let showRules = $state(true);
let showBar = $state(true);
let overtime = $state(true);
let bg = $state(false);
let admin = $state(false);
/** 预览模式：不连服务端，本地造一份状态 + 定时飘假礼物，给配置页的 iframe 用 */
let mock = $state(false);
let mockMinutes = $state(120);
let apiBase = $state(`${BASE}live-timer-api`);
let pollUrl = $state(`${BASE}api/live-timer.json`);

let toasts = $state<Toast[]>([]);
let seenAt = 0;
let toastId = 0;

let token = $state("");
let busy = $state(false);
let controlError = $state("");

const remaining = $derived.by(() => {
	if (!snap) return 0;
	if (snap.paused) return snap.pausedRemainingMs;
	return snap.deadline - (nowMs + skew);
});

const over = $derived(snap !== null && remaining <= 0);
const stale = $derived(lastOkAt > 0 && nowMs - lastOkAt > 12000);
const disconnected = $derived(Boolean(snap) && snap?.connected === false);

const totalMs = $derived(
	Math.max(1, (snap?.initialMs ?? 0) + (snap?.addedMs ?? 0)),
);
const percent = $derived(
	snap
		? Math.min(100, Math.max(0, (Math.max(0, remaining) / totalMs) * 100))
		: 100,
);

const timeText = $derived(
	snap === null
		? "--:--"
		: formatClock(remaining > 0 ? remaining : overtime ? -remaining : 0),
);

/** 价目：优先用服务端按礼物表算出来的，预览模式用示例 */
const ruleHints = $derived(
	(snap?.rules ?? (mock ? MOCK_RULES : [])).filter(
		(rule) => Number.isFinite(rule.minutes) && rule.minutes !== 0,
	),
);

/**
 * 把「每个多少分钟」翻译成观众一眼能懂的价目：
 * 0.1 → 10 个 = +1 分钟；2 → 1 个 = +2 分钟
 */
function ruleText(minutes: number): string {
	const per = Math.abs(minutes);
	const sign = minutes < 0 ? "−" : "+";
	const qty = Math.round(1 / per);
	// 1/0.1 在浮点里是 10.000000000000002，别用 Number.isInteger 判
	if (qty >= 1 && Math.abs(qty * per - 1) < 1e-9 && qty <= 100_000) {
		return `${qty} 个 = ${sign}1 分钟`;
	}
	const shown = Math.round(per * 10) / 10;
	return `1 个 = ${sign}${shown} 分钟`;
}

function iconOf(name: string): string {
	return GIFT_ICONS[name.trim()] ?? "";
}

function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(minutes)}:${pad(seconds)}`
		: `${pad(minutes)}:${pad(seconds)}`;
}

/** 把毫秒格式化成 "45 分钟" / "1 小时 20 分" 这种 */
function formatSpan(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function addToast(event: GiftEvent): void {
	toastId += 1;
	const id = toastId;
	toasts = [...toasts.slice(-2), { ...event, id }];
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
	}, TOAST_LIFETIME);
}

function ingest(next: Snapshot): void {
	const recent = next.recent ?? [];
	if (seenAt === 0) {
		// 首次加载不把历史礼物全飘一遍，但刚发生的（15 秒内）还是飘一下，
		// 这样 OBS 刷新页面、刚送完礼物的那一会儿观感是连续的
		seenAt = recent.reduce((max, e) => Math.max(max, e.at ?? 0), 0);
		const serverNow = Date.now() + skew;
		const fresh = recent.filter((e) => serverNow - (e.at ?? 0) < 15000);
		for (const event of fresh.slice(0, 3).reverse()) addToast(event);
		return;
	}
	const fresh = recent.filter((e) => (e.at ?? 0) > seenAt);
	if (fresh.length === 0) return;
	seenAt = fresh.reduce((max, e) => Math.max(max, e.at ?? 0), seenAt);
	for (const event of fresh.slice(0, 3).reverse()) addToast(event);
}

function applySnapshot(next: Snapshot): void {
	snap = next;
	skew = (next.now ?? Date.now()) - Date.now();
	lastOkAt = Date.now();
	if (showGifts) ingest(next);
}

async function poll(): Promise<void> {
	try {
		const res = await fetch(`${pollUrl}?t=${Date.now()}`, {
			cache: "no-store",
		});
		if (!res.ok) throw new Error(`状态文件 HTTP ${res.status}`);
		applySnapshot((await res.json()) as Snapshot);
		failure = "";
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
}

async function control(action: string, minutes?: number): Promise<void> {
	if (busy) return;
	if (!token) {
		controlError = "先填控制口令（配置里的 adminToken）";
		return;
	}
	busy = true;
	try {
		const res = await fetch(`${apiBase}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-timer-token": token },
			body: JSON.stringify({ action, minutes }),
		});
		const payload = (await res.json()) as {
			ok?: boolean;
			error?: string;
			state?: Snapshot;
		};
		if (!res.ok || !payload.ok)
			throw new Error(payload.error ?? `HTTP ${res.status}`);
		if (payload.state) applySnapshot(payload.state);
		controlError = "";
		try {
			localStorage.setItem("live-timer-token", token);
		} catch {
			// 隐私模式下写不了，无所谓
		}
	} catch (err) {
		controlError = `操作失败：${err instanceof Error ? err.message : String(err)}`;
	} finally {
		busy = false;
	}
}

function readParams(): void {
	const params = new URLSearchParams(window.location.search);
	const num = (key: string, fallback: number) => {
		const value = Number(params.get(key));
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};
	scale = Math.min(4, num("scale", 1));
	pos = params.get("pos") ?? "bl";
	label = params.get("label") ?? DEFAULT_LABEL;
	accent = params.get("accent") ?? "#FB7299";
	theme = params.get("theme") === "light" ? "light" : "dark";
	showGifts = params.get("gifts") !== "0";
	showRules = params.get("rules") !== "0";
	showBar = params.get("bar") !== "0";
	overtime = params.get("overtime") !== "0";
	bg = params.get("bg") === "1";
	admin = params.get("admin") === "1";
	mock = params.get("mock") === "1";
	mockMinutes = Math.min(600, num("mockMinutes", 120));
	apiBase = (params.get("api") ?? `${BASE}live-timer-api`).replace(/\/$/, "");
	if (admin) {
		try {
			token = localStorage.getItem("live-timer-token") ?? "";
		} catch {
			token = "";
		}
	}
}

onMount(() => {
	readParams();

	const ticker = window.setInterval(() => {
		nowMs = Date.now();
	}, 200);

	// 预览模式：不轮询，本地造一个「还剩 mockMinutes、已加时 45 分钟」的状态，
	// 每 6 秒飘一条假礼物，用来在配置页里看真实样式
	if (mock) {
		const now = Date.now();
		applySnapshot({
			v: 1,
			now,
			updatedAt: new Date(now).toISOString(),
			roomId: 0,
			deadline: now + mockMinutes * 60_000,
			paused: false,
			pausedRemainingMs: 0,
			remainingMs: mockMinutes * 60_000,
			initialMs: mockMinutes * 60_000,
			addedMs: 45 * 60_000,
			removedMs: 0,
			giftCount: 12,
			recent: [],
			lastGift: null,
			rules: MOCK_RULES,
			connected: true,
			reason: "预览",
		});
		const samples = [
			{ user: "小明", label: "小花花 ×3", deltaMs: 3 * 60_000 },
			{ user: "阿离", label: "大航海（舰长）", deltaMs: 30 * 60_000 },
			{ user: "路人甲", label: "火锅 ×1", deltaMs: 5 * 60_000 },
		];
		let cursor = 0;
		const feed = window.setInterval(() => {
			lastOkAt = Date.now();
			const sample = samples[cursor % samples.length];
			cursor += 1;
			if (showGifts) addToast({ ...sample, kind: "gift", at: Date.now() });
		}, 6000);
		return () => {
			window.clearInterval(feed);
			window.clearInterval(ticker);
		};
	}

	let alive = true;
	let pollTimer = 0;
	const loop = async () => {
		await poll();
		if (alive) pollTimer = window.setTimeout(loop, 1000);
	};
	void loop();

	// 从后台切回来时立刻刷新一次，别等轮询周期
	const onVisible = () => {
		if (document.visibilityState === "visible") void poll();
	};
	document.addEventListener("visibilitychange", onVisible);

	return () => {
		alive = false;
		window.clearTimeout(pollTimer);
		window.clearInterval(ticker);
		document.removeEventListener("visibilitychange", onVisible);
	};
});
</script>

<div
	class="stage"
	class:pos-bl={pos === "bl"}
	class:pos-bc={pos === "bc"}
	class:pos-br={pos === "br"}
	class:pos-tl={pos === "tl"}
	class:pos-tc={pos === "tc"}
	class:pos-tr={pos === "tr"}
	class:light={theme === "light"}
	class:with-bg={bg}
	style={`--scale:${scale}; --accent:${accent};`}
>
	<div class="stack">
		{#if showGifts && toasts.length > 0}
			<ul class="toasts">
				{#each toasts as toast (toast.id)}
					<li class="toast">
						<span class="toast-user">{toast.user}</span>
						<span class="toast-gift">{toast.label}</span>
						<span class="toast-delta">+{formatSpan(toast.deltaMs)}</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if showRules && ruleHints.length > 0}
			<ul class="rules">
				{#each ruleHints as rule (rule.name)}
					<li class="rule" class:minus={rule.minutes < 0}>
						{#if iconOf(rule.name)}
							<img
								class="rule-icon"
								src={iconOf(rule.name)}
								alt=""
								onerror={(event) => {
									event.currentTarget.style.display = "none";
								}}
							/>
						{/if}
						<span class="rule-name">{rule.name}</span>
						<span class="rule-rate">{ruleText(rule.minutes)}</span>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="card" class:paused={snap?.paused} class:over={over && overtime}>
			<div class="head">
				<span class="label">{label}</span>
				{#if over && overtime}
					<span class="badge">加班中</span>
				{:else if snap?.paused}
					<span class="badge">已暂停</span>
				{/if}
				<span
					class="dot"
					class:off={stale || disconnected}
					title={stale ? "状态文件没更新了" : disconnected ? "弹幕未连接" : "正常"}
				></span>
			</div>

			<div class="time" class:alert={over && overtime}>{timeText}</div>

			{#if showBar}
				<div class="bar"><i style={`width:${percent}%`}></i></div>
				<div class="meta">
					<span>已加时 {formatSpan(snap?.addedMs ?? 0)}</span>
					<span class="sep">·</span>
					<span>礼物 {snap?.giftCount ?? 0} 次</span>
					{#if snap && snap.removedMs > 0}
						<span class="sep">·</span>
						<span>已减 {formatSpan(snap.removedMs)}</span>
					{/if}
				</div>
			{/if}

			{#if failure && admin}
				<p class="error">{failure}</p>
			{/if}
		</div>

		{#if admin}
			<div class="admin">
				<div class="admin-row">
					<input
						class="input"
						type="password"
						placeholder="控制口令"
						bind:value={token}
						autocomplete="off"
					/>
					<span class="status" class:bad={Boolean(controlError)}>
						{controlError || (busy ? "处理中…" : "已就绪")}
					</span>
				</div>
				<div class="admin-row">
					<button type="button" onclick={() => control("start")}>重新开局</button>
					<button type="button" onclick={() => control("pause")}>暂停</button>
					<button type="button" onclick={() => control("resume")}>继续</button>
					<button type="button" onclick={() => control("add", 1)}>+1 分</button>
					<button type="button" onclick={() => control("sub", 1)}>-1 分</button>
					<button type="button" onclick={() => control("add", 10)}>+10 分</button>
				</div>
				<p class="admin-tip">
					这个控制台要能用，得让 nginx 把 {apiBase} 反代到服务端的 8848 端口（见 docs/live-timer.md）。
					放进 OBS 的地址别带 <code>admin=1</code>。
				</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.stage {
		position: fixed;
		inset: 0;
		display: flex;
		padding: 28px;
		color: #fff;
		font-family:
			system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC",
			"Microsoft YaHei", sans-serif;
		pointer-events: none;
	}

	.stage.with-bg {
		background:
			radial-gradient(circle at 20% 20%, #1e2233 0%, #0b0d14 60%, #05060a 100%);
	}

	.stage.light {
		color: #14161d;
	}

	.pos-bl {
		align-items: flex-end;
		justify-content: flex-start;
	}
	.pos-bc {
		align-items: flex-end;
		justify-content: center;
	}
	.pos-br {
		align-items: flex-end;
		justify-content: flex-end;
	}
	.pos-tl {
		align-items: flex-start;
		justify-content: flex-start;
	}
	.pos-tc {
		align-items: flex-start;
		justify-content: center;
	}
	.pos-tr {
		align-items: flex-start;
		justify-content: flex-end;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 10px;
		transform: scale(var(--scale));
		transform-origin: bottom left;
	}

	.pos-bc .stack,
	.pos-tc .stack {
		align-items: center;
		transform-origin: bottom center;
	}
	.pos-br .stack,
	.pos-tr .stack {
		align-items: flex-end;
		transform-origin: bottom right;
	}
	.pos-tl .stack {
		transform-origin: top left;
	}
	.pos-tc .stack {
		transform-origin: top center;
	}
	.pos-tr .stack {
		transform-origin: top right;
	}

	.card {
		min-width: 300px;
		padding: 18px 24px 16px;
		border-radius: 18px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(14, 15, 22, 0.62);
		backdrop-filter: blur(14px) saturate(1.2);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
	}

	.light .card {
		border-color: rgba(20, 22, 30, 0.12);
		background: rgba(255, 255, 255, 0.78);
		box-shadow: 0 12px 40px rgba(80, 90, 120, 0.2);
	}

	.rules {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-width: 460px;
	}

	.rule {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px 5px 6px;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(14, 15, 22, 0.6);
		backdrop-filter: blur(10px);
		font-size: 12.5px;
		line-height: 1;
		white-space: nowrap;
	}

	.light .rule {
		background: rgba(255, 255, 255, 0.82);
		border-color: rgba(20, 22, 30, 0.1);
	}

	.rule-icon {
		width: 22px;
		height: 22px;
		object-fit: contain;
		flex: none;
	}

	.rule-name {
		opacity: 0.9;
	}

	.rule-rate {
		color: #4ade80;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.rule.minus .rule-rate {
		color: #f87171;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.label {
		font-size: 13px;
		letter-spacing: 0.18em;
		opacity: 0.68;
	}

	.badge {
		font-size: 11px;
		line-height: 1;
		padding: 4px 7px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.14);
		letter-spacing: 0.06em;
	}

	.over .badge {
		background: var(--accent);
		color: #fff;
	}

	.dot {
		width: 7px;
		height: 7px;
		margin-left: auto;
		border-radius: 50%;
		background: #4ade80;
		box-shadow: 0 0 10px #4ade80;
	}

	.dot.off {
		background: #fbbf24;
		box-shadow: 0 0 10px #fbbf24;
	}

	.time {
		margin: 6px 0 2px;
		font-family: ui-monospace, "SFMono-Regular", "Consolas", "Menlo", monospace;
		font-size: 60px;
		font-weight: 700;
		line-height: 1.02;
		letter-spacing: 0.02em;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 2px 18px rgba(0, 0, 0, 0.35);
	}

	.time.alert {
		color: var(--accent);
		animation: breathe 2.4s ease-in-out infinite;
	}

	@keyframes breathe {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.62;
		}
	}

	.bar {
		position: relative;
		height: 5px;
		margin-top: 12px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.13);
		overflow: hidden;
	}

	.light .bar {
		background: rgba(20, 22, 30, 0.12);
	}

	.bar i {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 999px;
		background: var(--accent);
		transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.meta {
		display: flex;
		gap: 6px;
		margin-top: 9px;
		font-size: 12px;
		opacity: 0.6;
		font-variant-numeric: tabular-nums;
	}

	.sep {
		opacity: 0.5;
	}

	.toasts {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-width: 340px;
	}

	.toast {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 7px 12px;
		border-radius: 999px;
		background: rgba(14, 15, 22, 0.66);
		border: 1px solid rgba(255, 255, 255, 0.12);
		font-size: 12.5px;
		animation: toast-in 0.35s ease-out both;
	}

	.light .toast {
		background: rgba(255, 255, 255, 0.82);
		border-color: rgba(20, 22, 30, 0.1);
	}

	.toast-user {
		max-width: 9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.85;
	}

	.toast-gift {
		opacity: 0.62;
	}

	.toast-delta {
		margin-left: auto;
		color: var(--accent);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.admin {
		pointer-events: auto;
		width: min(520px, 92vw);
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(14, 15, 22, 0.82);
		font-size: 12px;
	}

	.light .admin {
		background: rgba(255, 255, 255, 0.9);
		border-color: rgba(20, 22, 30, 0.12);
		color: #14161d;
	}

	.admin-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.admin-row + .admin-row {
		margin-top: 8px;
	}

	.input {
		flex: 1;
		min-width: 160px;
		padding: 6px 10px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(0, 0, 0, 0.28);
		color: inherit;
		font: inherit;
	}

	.status {
		opacity: 0.6;
	}

	.status.bad {
		color: #f87171;
		opacity: 1;
	}

	.admin button {
		padding: 6px 10px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.admin button:hover {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}

	.admin-tip {
		margin: 8px 0 0;
		font-size: 11px;
		line-height: 1.6;
		opacity: 0.5;
	}

	.admin-tip code {
		font-family: ui-monospace, "Consolas", monospace;
	}

	.error {
		margin: 8px 0 0;
		font-size: 11px;
		color: #f87171;
	}

	@media (prefers-reduced-motion: reduce) {
		.time.alert,
		.toast {
			animation: none;
		}
	}
</style>
