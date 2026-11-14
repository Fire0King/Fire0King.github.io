<script lang="ts">
/**
 * 直播礼物统计
 *
 * 数据来自服务端的礼物流水（/var/lib/live-timer/gifts.jsonl），
 * 由 /stats 接口按时间范围 + 礼物 + 用户过滤后聚合返回。
 * 页面本身是静态的，所有计算都在服务端做，浏览器只负责渲染。
 */
import { onMount } from "svelte";

const BASE = import.meta.env.BASE_URL;

/** 一行的统计结果（天 / 月 / 年 / 礼物 / 用户 通用） */
interface Row {
	key: string;
	events: number;
	count: number;
	ms: number;
	cny: number;
	giftName?: string;
	giftId?: string;
	uid?: number;
	uname?: string;
	gifts?: { name: string; count: number; ms: number; cny: number }[];
}

interface StatsData {
	ok: boolean;
	range: { from: string; to: string; days: number };
	totals: {
		events: number;
		count: number;
		ms: number;
		cny: number;
		users: number;
		gifts: number;
	};
	byDay: Row[];
	byMonth: Row[];
	byYear: Row[];
	byGift: Row[];
	byUser: Row[];
	facets: {
		gifts: { name: string; count: number }[];
		users: { uid: number; uname: string; count: number }[];
	};
	totalEvents: number;
}

type View = "day" | "month" | "year" | "gift" | "user";

const VIEWS: { value: View; name: string }[] = [
	{ value: "day", name: "按天" },
	{ value: "month", name: "按月" },
	{ value: "year", name: "按年" },
	{ value: "gift", name: "按礼物" },
	{ value: "user", name: "按用户" },
];

const PRESETS: { value: string; name: string }[] = [
	{ value: "today", name: "今天" },
	{ value: "yesterday", name: "昨天" },
	{ value: "7d", name: "近 7 天" },
	{ value: "30d", name: "近 30 天" },
	{ value: "month", name: "本月" },
	{ value: "year", name: "本年" },
	{ value: "all", name: "全部" },
	{ value: "custom", name: "自定义" },
];

let apiBase = $state(`${BASE}live-timer-api`);

let token = $state("");
let loggedIn = $state(false);
let password = $state("");
let loginBusy = $state(false);
let loginError = $state("");

let view = $state<View>("day");
let preset = $state("7d");
let from = $state("");
let to = $state("");
let giftFilter = $state("");
let userFilter = $state("");
let uidFilter = $state(0);

let loading = $state(false);
let error = $state("");
let data = $state<StatsData | null>(null);
let expanded = $state<Record<string, boolean>>({});
let loadedOnce = $state(false);

const pad = (n: number) => String(n).padStart(2, "0");
function dayStr(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 快捷范围 → from/to（都是本地日期，服务端按本地时区切天） */
function applyPreset(next: string): void {
	preset = next;
	if (next === "custom") return;
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (next === "today") {
		from = dayStr(start);
		to = from;
	} else if (next === "yesterday") {
		const y = new Date(start);
		y.setDate(y.getDate() - 1);
		from = dayStr(y);
		to = from;
	} else if (next === "7d") {
		const s = new Date(start);
		s.setDate(s.getDate() - 6);
		from = dayStr(s);
		to = dayStr(start);
	} else if (next === "30d") {
		const s = new Date(start);
		s.setDate(s.getDate() - 29);
		from = dayStr(s);
		to = dayStr(start);
	} else if (next === "month") {
		from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
		to = dayStr(start);
	} else if (next === "year") {
		from = `${now.getFullYear()}-01-01`;
		to = dayStr(start);
	} else {
		from = "2000-01-01";
		to = dayStr(start);
	}
}

async function login(): Promise<void> {
	if (loginBusy) return;
	loginBusy = true;
	loginError = "";
	try {
		const res = await fetch(`${apiBase}/admin/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password }),
		});
		const payload = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			token?: string;
			error?: string;
		};
		if (!res.ok || !payload.ok || !payload.token) {
			throw new Error(payload.error ?? `HTTP ${res.status}`);
		}
		token = payload.token;
		password = "";
		loggedIn = true;
		try {
			sessionStorage.setItem("live-timer-token", token);
		} catch {
			// 隐私模式写不了，无所谓
		}
		await load();
	} catch (err) {
		loginError = err instanceof Error ? err.message : String(err);
	} finally {
		loginBusy = false;
	}
}

function logout(): void {
	token = "";
	loggedIn = false;
	data = null;
	try {
		sessionStorage.removeItem("live-timer-token");
	} catch {
		// ignore
	}
}

async function ensureLogin(): Promise<void> {
	try {
		token = sessionStorage.getItem("live-timer-token") ?? "";
	} catch {
		token = "";
	}
	if (!token) return;
	loggedIn = true;
	await load();
}

async function load(): Promise<void> {
	if (loading) return;
	loading = true;
	error = "";
	const params = new URLSearchParams();
	if (from) params.set("from", from);
	if (to) params.set("to", to);
	if (giftFilter) params.set("gift", giftFilter);
	if (uidFilter) params.set("uid", String(uidFilter));
	else if (userFilter.trim()) params.set("user", userFilter.trim());
	try {
		const res = await fetch(`${apiBase}/stats?${params.toString()}`, {
			headers: { authorization: `Bearer ${token}` },
			cache: "no-store",
		});
		if (res.status === 401) {
			logout();
			return;
		}
		const payload = (await res.json().catch(() => ({}))) as StatsData & {
			error?: string;
		};
		if (!res.ok || !payload.ok) {
			throw new Error(payload.error ?? `HTTP ${res.status}`);
		}
		data = payload;
		loadedOnce = true;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		loading = false;
	}
}

function fmtSpan(ms: number): string {
	const total = Math.abs(ms);
	if (total < 1000) return "—";
	if (total < 60_000) return `${Math.round(total / 1000)} 秒`;
	const minutes = Math.round(total / 60_000);
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function fmtCny(cny: number): string {
	if (!cny) return "—";
	return `¥${Math.round(cny * 100) / 100}`;
}

/** 当前视角的表格数据 */
const rows = $derived.by<Row[]>(() => {
	if (!data) return [];
	if (view === "day") return data.byDay;
	if (view === "month") return data.byMonth;
	if (view === "year") return data.byYear;
	if (view === "gift") return data.byGift;
	return data.byUser;
});

const maxCount = $derived(
	rows.reduce((max, row) => Math.max(max, row.count), 1),
);

const labelOf = (row: Row): string => {
	if (view === "gift") return row.giftName ?? row.key;
	if (view === "user") return row.uname ?? `uid ${row.uid}`;
	return row.key;
};

function onFilterChange(): void {
	void load();
}

function toggleRow(key: string): void {
	expanded = { ...expanded, [key]: !expanded[key] };
}

onMount(() => {
	const override = new URLSearchParams(window.location.search).get("api");
	if (override) apiBase = override.replace(/\/$/, "");
	applyPreset(preset);
	void ensureLogin();
});
</script>

{#if !loggedIn}
	<div class="gate">
		<div class="gate-card">
			<h1>礼物统计</h1>
			<p class="gate-tip">
				这里能看到每天谁送了什么、送了多少，只对自己开放，先输入网页口令。
			</p>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void login();
				}}
			>
				<input
					type="password"
					placeholder="网页登录口令"
					bind:value={password}
					autocomplete="current-password"
				/>
				<button type="submit" class="primary" disabled={loginBusy || !password}>
					{loginBusy ? "登录中…" : "进入"}
				</button>
			</form>
			{#if loginError}<p class="gate-error">{loginError}</p>{/if}
			<p class="gate-back">
				<a href={`${BASE}live-timer/config/`}>← 回配置页</a>
			</p>
		</div>
	</div>
{:else}
	<div class="wrap">
		<header class="head">
			<div>
				<h1>礼物统计</h1>
				<p class="sub">
					{#if data}
						共 {data.totals.events} 次礼物 · {data.totals.count} 件 ·
						<strong>{fmtSpan(data.totals.ms)}</strong> 加时 ·
						{fmtCny(data.totals.cny)} ·
						{data.totals.users} 位观众
						{#if data.range.days > 1}
							<span class="dim">（{data.range.from} ~ {data.range.to}）</span>
						{/if}
					{:else}
						正在读取礼物流水…
					{/if}
				</p>
			</div>
			<div class="head-actions">
				<a class="ghost" href={`${BASE}live-timer/config/`}>回配置页</a>
				<button type="button" class="ghost" onclick={() => load()} disabled={loading}>
					{loading ? "刷新中…" : "刷新"}
				</button>
				<button type="button" class="ghost" onclick={logout}>退出</button>
			</div>
		</header>

		<section class="filters">
			<div class="chips">
				{#each PRESETS as item (item.value)}
					<button
						type="button"
						class="chip"
						class:active={preset === item.value}
						onclick={() => {
							applyPreset(item.value);
							if (item.value !== "custom") onFilterChange();
						}}
					>
						{item.name}
					</button>
				{/each}
			</div>

			<div class="range">
				<label>
					<span>开始</span>
					<input
						type="date"
						bind:value={from}
						onchange={() => {
							preset = "custom";
							onFilterChange();
						}}
					/>
				</label>
				<label>
					<span>结束</span>
					<input
						type="date"
						bind:value={to}
						onchange={() => {
							preset = "custom";
							onFilterChange();
						}}
					/>
				</label>
			</div>

			<div class="picks">
				<label>
					<span>礼物</span>
					<select
						bind:value={giftFilter}
						onchange={onFilterChange}
					>
						<option value="">全部礼物</option>
						{#each data?.facets.gifts ?? [] as g (g.name)}
							<option value={g.name}>{g.name}（{g.count}）</option>
						{/each}
					</select>
				</label>
				<label>
					<span>用户</span>
					<select
						value={uidFilter ? String(uidFilter) : ""}
						onchange={(event) => {
							const v = event.currentTarget.value;
							uidFilter = v ? Number(v) : 0;
							userFilter = "";
							onFilterChange();
						}}
					>
						<option value="">全部用户</option>
						{#each data?.facets.users ?? [] as u (u.uid || u.uname)}
							<option value={u.uid || ""}>
								{u.uname}（{u.count}）
							</option>
						{/each}
					</select>
				</label>
				<button
					type="button"
					class="ghost reset"
					onclick={() => {
						giftFilter = "";
						uidFilter = 0;
						userFilter = "";
						preset = "7d";
						applyPreset("7d");
						onFilterChange();
					}}
				>
					重置筛选
				</button>
			</div>
		</section>

		<nav class="tabs">
			{#each VIEWS as item (item.value)}
				<button
					type="button"
					class="tab"
					class:active={view === item.value}
					onclick={() => (view = item.value)}
				>
					{item.name}
					{#if data}
						<em>
							{view === item.value
								? rows.length
								: item.value === "day"
									? data.byDay.length
									: item.value === "month"
										? data.byMonth.length
										: item.value === "year"
											? data.byYear.length
											: item.value === "gift"
												? data.byGift.length
												: data.byUser.length}
						</em>
					{/if}
				</button>
			{/each}
		</nav>

		{#if error}
			<p class="err">{error}</p>
		{/if}

		<section class="table-card">
			{#if rows.length === 0}
				<p class="empty">
					{loadedOnce ? "这个范围内没有礼物记录。" : "读取中…"}
				</p>
			{:else}
				<table>
					<thead>
						<tr>
							<th>{view === "gift" ? "礼物" : view === "user" ? "观众" : "时间"}</th>
							<th class="num">次数</th>
							<th class="num">件数</th>
							<th class="num">加时</th>
							<th class="num">金额</th>
							<th class="share">占比</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.key)}
							<tr
								class:clickable={view === "user" && (row.gifts?.length ?? 0) > 0}
								onclick={() => {
									if (view === "user" && (row.gifts?.length ?? 0) > 0) {
										toggleRow(row.key);
									}
								}}
							>
								<td class="name">
									{#if view === "user" && (row.gifts?.length ?? 0) > 0}
										<span class="caret">{expanded[row.key] ? "▾" : "▸"}</span>
									{/if}
									{labelOf(row)}
								</td>
								<td class="num">{row.events}</td>
								<td class="num">{row.count}</td>
								<td class="num" class:neg={row.ms < 0}>{fmtSpan(row.ms)}</td>
								<td class="num">{fmtCny(row.cny)}</td>
								<td class="share">
									<span class="bar">
										<i style={`width: ${Math.round((row.count / maxCount) * 100)}%`}></i>
									</span>
								</td>
							</tr>
							{#if view === "user" && expanded[row.key] && row.gifts}
								{#each row.gifts as g (g.name)}
									<tr class="sub">
										<td class="name">↳ {g.name}</td>
										<td class="num">—</td>
										<td class="num">{g.count}</td>
										<td class="num">{fmtSpan(g.ms)}</td>
										<td class="num">{fmtCny(g.cny)}</td>
										<td class="share"></td>
									</tr>
								{/each}
							{/if}
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<p class="foot">
			统计来自礼物流水（{data?.totalEvents ?? 0} 条记录），只统计服务端收到的礼物事件；
			「加时」是实际生效的时长（可能被上限/单人限速截断）。
		</p>
	</div>
{/if}

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		color: var(--deep-text);
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 700;
	}

	.sub {
		margin: 0.3rem 0 0;
		font-size: 0.82rem;
		color: var(--content-meta);
	}

	.dim {
		opacity: 0.7;
	}

	.head-actions {
		display: flex;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	button,
	select,
	input {
		font: inherit;
		font-size: 0.82rem;
	}

	.ghost,
	.chip,
	.tab {
		padding: 0.38rem 0.7rem;
		border-radius: 0.55rem;
		border: 1px solid var(--line-divider);
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.ghost:hover,
	.chip:hover,
	.tab:hover {
		background-color: var(--btn-regular-bg-hover);
	}

	.chip.active,
	.tab.active {
		border-color: var(--primary);
		color: var(--primary);
		font-weight: 700;
	}

	.filters {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.85rem 0.95rem;
		border-radius: 0.85rem;
		border: 1px solid var(--line-divider);
		background-color: var(--card-bg);
	}

	.chips,
	.range,
	.picks {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		align-items: center;
	}

	.range label,
	.picks label {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: var(--content-meta);
	}

	.range input,
	.picks select {
		padding: 0.32rem 0.5rem;
		border-radius: 0.5rem;
		border: 1px solid var(--line-divider);
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
	}

	.picks select {
		max-width: 12rem;
	}

	.reset {
		margin-left: auto;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.tab em {
		margin-left: 0.3rem;
		font-style: normal;
		font-size: 0.7rem;
		opacity: 0.65;
	}

	.table-card {
		border-radius: 0.85rem;
		border: 1px solid var(--line-divider);
		background-color: var(--card-bg);
		overflow: hidden;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
	}

	th,
	td {
		padding: 0.5rem 0.75rem;
		text-align: left;
		border-bottom: 1px solid var(--line-divider);
	}

	th {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--content-meta);
		background-color: var(--btn-plain-bg-hover);
		position: sticky;
		top: 0;
		backdrop-filter: blur(6px);
	}

	tbody tr:last-child td {
		border-bottom: none;
	}

	tr.clickable {
		cursor: pointer;
	}

	tbody tr:hover td {
		background-color: var(--btn-plain-bg-hover);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.neg {
		color: #f43f5e;
	}

	.name {
		max-width: 18rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.caret {
		margin-right: 0.25rem;
		opacity: 0.6;
	}

	tr.sub td {
		font-size: 0.76rem;
		color: var(--content-meta);
	}

	.share {
		width: 22%;
	}

	.bar {
		display: block;
		height: 0.4rem;
		border-radius: 999px;
		background-color: var(--btn-regular-bg);
		overflow: hidden;
	}

	.bar i {
		display: block;
		height: 100%;
		border-radius: 999px;
		background-color: var(--primary);
	}

	.empty {
		padding: 2rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--content-meta);
	}

	.err {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border-radius: 0.6rem;
		background-color: rgba(244, 63, 94, 0.12);
		color: #f43f5e;
		font-size: 0.8rem;
	}

	.foot {
		margin: 0;
		font-size: 0.75rem;
		color: var(--content-meta);
	}

	/* 登录闸门 */
	.gate {
		display: flex;
		justify-content: center;
		padding: 3rem 0;
	}

	.gate-card {
		width: min(24rem, 100%);
		padding: 1.4rem 1.5rem;
		border-radius: 1rem;
		border: 1px solid var(--line-divider);
		background-color: var(--card-bg);
	}

	.gate-card h1 {
		font-size: 1.25rem;
	}

	.gate-tip {
		margin: 0.5rem 0 1rem;
		font-size: 0.8rem;
		line-height: 1.7;
		color: var(--content-meta);
	}

	.gate-card form {
		display: flex;
		gap: 0.5rem;
	}

	.gate-card input {
		flex: 1;
		padding: 0.5rem 0.65rem;
		border-radius: 0.55rem;
		border: 1px solid var(--line-divider);
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
	}

	.primary {
		padding: 0.5rem 0.9rem;
		border-radius: 0.55rem;
		border: 1px solid var(--primary);
		background-color: var(--primary);
		color: #fff;
		font-weight: 600;
		cursor: pointer;
	}

	.primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.gate-error {
		margin: 0.7rem 0 0;
		font-size: 0.78rem;
		color: #f43f5e;
	}

	.gate-back {
		margin: 1rem 0 0;
		font-size: 0.78rem;
	}

	.gate-back a {
		color: var(--primary);
	}
</style>
