<script lang="ts">
import { untrack } from "svelte";
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type {
	FollowerPlatformSeries,
	LiveActiveStream,
	LiveMonthOption,
	LivePlatformId,
	LiveStreamRecord,
} from "@/types/liveReport";
import {
	buildCalendarMonth,
	buildFollowerSeries,
	formatDuration,
	formatMonthLabel,
	getLiveReportLocale,
	getTodayKey,
	shiftMonthKey,
	toClock,
} from "@/utils/live-report-utils";
import FollowerChart from "./FollowerChart.svelte";
import LiveCalendar from "./LiveCalendar.svelte";
import LiveIcon from "./LiveIcon.svelte";

interface Props {
	/** 已结束的直播场次（含手动补录） */
	records: LiveStreamRecord[];
	/** 正在直播的场次 */
	active: Partial<Record<LivePlatformId, LiveActiveStream>>;
	/** 粉丝快照 */
	followers: Partial<Record<LivePlatformId, FollowerPlatformSeries>>;
	/** 月份选项 */
	months: LiveMonthOption[];
	/** 初始展示的月份 YYYY-MM */
	initialMonth: string;
	/** 已启用的平台 */
	platforms: LivePlatformId[];
	/** 站点语言，用于 Intl 本地化 */
	lang: string;
	/** 统计时区（来自 live-report.config.json） */
	timezone: string;
	/** 一周起始日（来自 live-report.config.json） */
	weekStart: "monday" | "sunday";
	/** 构建时的"今天"（配置时区），客户端水合后会重新校准 */
	todayKey: string;
}

let {
	records,
	active,
	followers,
	months,
	initialMonth,
	platforms,
	lang,
	timezone,
	weekStart,
	todayKey: buildTodayKey,
}: Props = $props();

// 构建时写入的"今天"可能在页面部署后过期，客户端水合后重新校准一次，
// 这样既不会产生水合不一致，也能保证"今天"标记始终正确。
let todayKey = $state(buildTodayKey);
$effect(() => {
	const timeZone = timezone;
	const fresh = getTodayKey(timeZone);
	if (fresh !== untrack(() => todayKey)) todayKey = fresh;
});

const locale = getLiveReportLocale(lang);

/** 当前展示的月份 */
let month = $state(initialMonth);
/** 平台筛选 */
let platform = $state<LivePlatformId | "all">("all");
/** 选中的日期，默认选中今天（如果今天有直播） */
let selectedDate = $state<string | null>(
	records.some((record) => record.date === todayKey) ? todayKey : null,
);

/** 正在直播的场次列表 */
const activeList = $derived(
	Object.values(active).filter((stream): stream is LiveActiveStream =>
		Boolean(stream),
	),
);

const calendar = $derived.by(() =>
	buildCalendarMonth(month, records, {
		weekStart,
		todayKey,
		platform,
		timezone,
		activeStreams: activeList,
	}),
);

const followerSeries = $derived.by(() =>
	platforms.map((item) =>
		buildFollowerSeries(
			item,
			{ version: 1, updatedAt: null, series: followers },
			month,
		),
	),
);

const monthLabel = $derived.by(() => {
	const option = months.find((item) => item.key === month);
	return option?.label ?? formatMonthLabel(month, locale);
});

const selectedDay = $derived.by(() => {
	if (!selectedDate) return null;
	return calendar.cells.find((cell) => cell.date === selectedDate) ?? null;
});

const hasFollowerData = $derived(
	platforms.some((item) => (followers[item]?.points?.length ?? 0) > 0),
);

/**
 * 距离上次直播多少天：按**全部**记录里最近的一场算（不受当前选中月份影响），
 * 没有任何记录时返回 null，页面显示 "—"。
 * 用响应式状态 todayKey（构建时的"今天"会在客户端水合后重新校准）。
 */
const daysSinceLastStream = $derived.by(() => {
	const last = records.reduce<string | null>(
		(max, record) =>
			record.date && (!max || record.date > max) ? record.date : max,
		null,
	);
	if (!last) return null;
	const diff = Math.round(
		(Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) /
			86400000,
	);
	return Number.isFinite(diff) && diff >= 0 ? diff : null;
});

/** 月度统计卡片数据 */
const stats = $derived.by(() => {
	const hourUnit = i18n(I18nKey.liveReportHourUnit);
	const minuteUnit = i18n(I18nKey.liveReportMinuteUnit);
	return [
		{
			key: "days",
			icon: "calendar" as const,
			label: i18n(I18nKey.liveReportLiveDays),
			value: String(calendar.stats.liveDays),
			unit: i18n(I18nKey.liveReportDayUnit),
		},
		{
			key: "streams",
			icon: "broadcast" as const,
			label: i18n(I18nKey.liveReportStreamCount),
			value: String(calendar.stats.streamCount),
			unit: "",
		},
		{
			key: "total",
			icon: "clock" as const,
			label: i18n(I18nKey.liveReportTotalDuration),
			value: formatDuration(
				calendar.stats.totalDurationSeconds,
				hourUnit,
				minuteUnit,
			),
			unit: "",
		},
		{
			key: "average",
			icon: "chart" as const,
			label: i18n(I18nKey.liveReportAverageDuration),
			value: formatDuration(
				calendar.stats.averageDurationSeconds,
				hourUnit,
				minuteUnit,
			),
			unit: "",
		},
		{
			key: "longest",
			icon: "trophy" as const,
			label: i18n(I18nKey.liveReportLongestDuration),
			value: formatDuration(
				calendar.stats.longestDurationSeconds,
				hourUnit,
				minuteUnit,
			),
			unit: "",
		},
		{
			key: "since",
			icon: "star" as const,
			label: i18n(I18nKey.liveReportSinceLastStream),
			value: daysSinceLastStream === null ? "—" : String(daysSinceLastStream),
			unit: daysSinceLastStream === null ? "" : i18n(I18nKey.liveReportDayUnit),
		},
	];
});

function platformLabel(item: LivePlatformId): string {
	return item === "bilibili"
		? i18n(I18nKey.liveReportPlatformBilibili)
		: i18n(I18nKey.liveReportPlatformDouyin);
}

function platformChipLabel(item: LivePlatformId | "all"): string {
	return item === "all"
		? i18n(I18nKey.liveReportPlatformAll)
		: platformLabel(item);
}

function shiftMonth(delta: number): void {
	month = shiftMonthKey(month, delta);
	selectedDate = null;
}

/** 直播中已持续的时长 */
function activeElapsed(start: string): string {
	const minutes = Math.max(
		0,
		Math.round((Date.now() - new Date(start).getTime()) / 60000),
	);
	return formatDuration(
		minutes * 60,
		i18n(I18nKey.liveReportHourUnit),
		i18n(I18nKey.liveReportMinuteUnit),
	);
}
</script>

<div class="live-report">
	<!-- 控制条：月份切换 + 直播中 + 平台筛选 -->
	<div class="live-report-toolbar">
		<div class="live-report-month">
			<button
				type="button"
				class="live-report-step"
				title={i18n(I18nKey.liveReportPrevMonth)}
				aria-label={i18n(I18nKey.liveReportPrevMonth)}
				onclick={() => shiftMonth(-1)}
			>
				<LiveIcon name="chevronLeft" class="h-4 w-4" />
			</button>
			<select
				class="live-report-month-select"
				value={month}
				onchange={(event) => {
					month = (event.currentTarget as HTMLSelectElement).value;
					selectedDate = null;
				}}
			>
				{#each months as option (option.key)}
					<option value={option.key}>
						{option.label}{option.hasData ? "" : " ·"}
					</option>
				{/each}
			</select>
			<button
				type="button"
				class="live-report-step"
				title={i18n(I18nKey.liveReportNextMonth)}
				aria-label={i18n(I18nKey.liveReportNextMonth)}
				onclick={() => shiftMonth(1)}
			>
				<LiveIcon name="chevronRight" class="h-4 w-4" />
			</button>
		</div>

		<div class="live-report-toolbar-right">
			{#if activeList.length > 0}
				<span class="live-report-live-badge">
					<span class="live-report-live-dot" aria-hidden="true"></span>
					{i18n(I18nKey.liveReportStreaming)}
					<span class="live-report-live-detail">
						{activeList.map((item) => platformLabel(item.platform)).join(" / ")}
					</span>
				</span>
			{/if}

			{#if platforms.length > 1}
				<div class="live-report-chips">
					<button
						type="button"
						class="live-report-chip"
						class:is-active={platform === "all"}
						onclick={() => (platform = "all")}
					>
						{platformChipLabel("all")}
					</button>
					{#each platforms as item (item)}
						<button
							type="button"
							class="live-report-chip"
							class:is-active={platform === item}
							onclick={() => (platform = item)}
						>
							<span
								class="live-report-chip-dot"
								class:is-bilibili={item === "bilibili"}
								class:is-douyin={item === "douyin"}
								aria-hidden="true"
							></span>
							{platformChipLabel(item)}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- 正在直播 -->
	{#if activeList.length > 0}
		<div class="live-report-active-list">
			{#each activeList as item (item.platform)}
				<div class="live-report-active-item">
					<span
						class="live-report-active-platform"
						class:is-bilibili={item.platform === "bilibili"}
						class:is-douyin={item.platform === "douyin"}
					>
						{platformLabel(item.platform)}
					</span>
					<span class="live-report-active-title">{item.title}</span>
					<span class="live-report-active-time">
						{toClock(item.start, timezone)} · {activeElapsed(item.start)}
					</span>
					{#if item.url}
						<a
							class="live-report-active-link"
							href={item.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							{i18n(I18nKey.liveReportOpenRoom)}
							<LiveIcon name="external" class="h-3.5 w-3.5" />
						</a>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- 月度统计 -->
	<div class="live-report-stats">
		{#each stats as stat (stat.key)}
			<div class="live-report-stat">
				<span class="live-report-stat-label">
					<LiveIcon name={stat.icon} class="h-3.5 w-3.5" />
					{stat.label}
				</span>
				<span class="live-report-stat-value">
					{stat.value}{#if stat.unit}<small>{stat.unit}</small>{/if}
				</span>
			</div>
		{/each}
	</div>

	<!-- 直播月历 -->
	<section class="live-report-card">
		<header class="live-report-card-head">
			<div>
				<h3 class="live-report-card-title">
					{i18n(I18nKey.liveReportCalendar)}
				</h3>
				<p class="live-report-card-desc">
					{i18n(I18nKey.liveReportCalendarDesc)}
				</p>
			</div>
			<div class="live-report-platform-days">
				{#each platforms as item (item)}
					<span class="live-report-platform-day">
						<i
							class="live-report-platform-dot"
							class:is-bilibili={item === "bilibili"}
							class:is-douyin={item === "douyin"}
						></i>
						{platformLabel(item)}
						<strong>{calendar.stats.platformDays[item] ?? 0}</strong>
						{i18n(I18nKey.liveReportDayUnit)}
					</span>
				{/each}
			</div>
		</header>

		<LiveCalendar
			{calendar}
			{locale}
			{weekStart}
			{timezone}
			{selectedDate}
			onselect={(date) => (selectedDate = date)}
		/>

		<!-- 选中日详情 -->
		<div class="live-report-day">
			{#if !selectedDate}
				<p class="live-report-hint">{i18n(I18nKey.liveReportSelectDayHint)}</p>
			{:else if selectedDay?.summary}
				<div class="live-report-day-head">
					<span class="live-report-day-date">{selectedDate}</span>
					{#if selectedDay.isToday}
						<span class="live-report-day-today">
							{i18n(I18nKey.liveReportToday)}
						</span>
					{/if}
					<span class="live-report-day-total">
						{i18n(I18nKey.liveReportDuration)} ·
						{formatDuration(
							selectedDay.summary.totalDurationSeconds,
							i18n(I18nKey.liveReportHourUnit),
							i18n(I18nKey.liveReportMinuteUnit),
						)}
					</span>
				</div>
				<ul class="live-report-day-list">
					{#each selectedDay.summary.streams as stream (stream.id)}
						<li class="live-report-stream">
							<span
								class="live-report-stream-platform"
								class:is-bilibili={stream.platform === "bilibili"}
								class:is-douyin={stream.platform === "douyin"}
							>
								{platformLabel(stream.platform)}
							</span>
							{#if !stream.timeUnknown}
								<span class="live-report-stream-time">
									{toClock(stream.start, timezone)} - {toClock(stream.end, timezone)}
								</span>
							{/if}
							<span class="live-report-stream-title">{stream.title}</span>
							<span class="live-report-stream-duration">
								{formatDuration(
									stream.durationSeconds,
									i18n(I18nKey.liveReportHourUnit),
									i18n(I18nKey.liveReportMinuteUnit),
								)}
							</span>
							{#if stream.manual}
								<span class="live-report-stream-manual">
									{i18n(I18nKey.liveReportManual)}
								</span>
							{/if}
							{#if stream.url}
								<a
									class="live-report-stream-link"
									href={stream.url}
									target="_blank"
									rel="noopener noreferrer"
									aria-label={i18n(I18nKey.liveReportOpenRoom)}
									title={i18n(I18nKey.liveReportOpenRoom)}
								>
									<LiveIcon name="external" class="h-3.5 w-3.5" />
								</a>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="live-report-hint">{i18n(I18nKey.liveReportNoStreamThisDay)}</p>
			{/if}
		</div>
	</section>

	<!-- 粉丝报表 -->
	<section class="live-report-card">
		<header class="live-report-card-head">
			<div>
				<h3 class="live-report-card-title">
					{i18n(I18nKey.liveReportFollowerChart)}
				</h3>
				<p class="live-report-card-desc">
					{i18n(I18nKey.liveReportFollowerChartDesc)}
				</p>
			</div>
			<span class="live-report-range">{monthLabel}</span>
		</header>

		{#if hasFollowerData}
			<div class="live-report-charts">
				{#each followerSeries as series (series.platform)}
					<FollowerChart {series} {locale} />
				{/each}
			</div>
		{:else}
			<p class="live-report-hint">{i18n(I18nKey.liveReportNoFollowerData)}</p>
		{/if}
	</section>
</div>

<style>
	.live-report {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	/* ── 控制条 ────────────────────────────────────────── */
	.live-report-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius-large, 1rem);
		border: 1px solid var(--line-divider);
		background-color: var(--card-bg);
	}

	.live-report-month {
		display: flex;
		align-items: center;
		gap: 0.15rem;
	}

	.live-report-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.85rem;
		height: 1.85rem;
		border-radius: 0.55rem;
		border: none;
		background: transparent;
		color: var(--content-meta);
		cursor: pointer;
		transition:
			background-color 150ms ease,
			color 150ms ease;
	}

	.live-report-step:hover {
		background-color: var(--btn-regular-bg);
		color: var(--btn-content);
	}

	.live-report-step:focus-visible,
	.live-report-chip:focus-visible,
	.live-report-month-select:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.live-report-month-select {
		padding: 0.25rem 0.4rem;
		border: none;
		border-radius: 0.55rem;
		background: transparent;
		color: var(--deep-text);
		font-size: 0.95rem;
		font-weight: 700;
		cursor: pointer;
		transition: background-color 150ms ease;
	}

	.live-report-month-select:hover {
		background-color: var(--btn-regular-bg);
	}

	.live-report-toolbar-right {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.live-report-chips {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0.15rem;
		border-radius: 9999px;
		background-color: var(--btn-regular-bg);
	}

	.live-report-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		padding: 0.2rem 0.6rem;
		border: none;
		border-radius: 9999px;
		background: transparent;
		color: var(--content-meta);
		font-size: 0.75rem;
		cursor: pointer;
		transition:
			background-color 150ms ease,
			color 150ms ease;
	}

	.live-report-chip:hover {
		color: var(--deep-text);
	}

	.live-report-chip.is-active {
		background-color: var(--card-bg);
		color: var(--deep-text);
		font-weight: 600;
		box-shadow: var(--shadow-sm);
	}

	.live-report-chip-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
	}

	.live-report-chip-dot.is-bilibili {
		background-color: #fb7299;
	}

	.live-report-chip-dot.is-douyin {
		background-color: #22c9d6;
	}

	.live-report-live-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.2rem 0.6rem;
		border-radius: 9999px;
		background-color: rgba(244, 63, 94, 0.12);
		color: #e11d48;
		font-size: 0.75rem;
		font-weight: 600;
	}

	/* 暗色下保持同一个红，但提亮：固定色 #e11d48 在深底上对比度只有 ~2 */
	:global(.dark) .live-report-live-badge {
		background-color: rgba(244, 63, 94, 0.2);
		color: oklch(0.75 0.16 15);
	}

	.live-report-live-detail {
		font-weight: 400;
		opacity: 0.85;
	}

	.live-report-live-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 9999px;
		background-color: #f43f5e;
		animation: live-report-pulse 1.8s ease-out infinite;
	}

	@keyframes live-report-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.5);
		}
		70% {
			box-shadow: 0 0 0 0.4rem rgba(244, 63, 94, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(244, 63, 94, 0);
		}
	}

	/* ── 正在直播 ──────────────────────────────────────── */
	.live-report-active-list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.live-report-active-item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid rgba(244, 63, 94, 0.25);
		border-left-width: 3px;
		border-radius: 0.75rem;
		background-color: rgba(244, 63, 94, 0.06);
		font-size: 0.82rem;
		color: var(--deep-text);
	}

	.live-report-active-platform {
		flex: none;
		padding: 0.05rem 0.4rem;
		border-radius: 9999px;
		font-size: 0.68rem;
		font-weight: 600;
		color: white;
	}

	.live-report-active-platform.is-bilibili {
		background-color: #fb7299;
	}

	.live-report-active-platform.is-douyin {
		background-color: #22c9d6;
	}

	.live-report-active-title {
		flex: 1 1 12rem;
		min-width: 0;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-report-active-time {
		color: var(--content-meta);
		font-variant-numeric: tabular-nums;
	}

	.live-report-active-link {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		color: var(--btn-content);
	}

	/* ── 统计卡片 ──────────────────────────────────────── */
	.live-report-stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}

	.live-report-stat {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.7rem 0.8rem;
		border-radius: 0.85rem;
		border: 1px solid var(--line-divider);
		background-color: var(--card-bg);
		transition:
			transform 150ms ease,
			border-color 150ms ease;
	}

	.live-report-stat:hover {
		transform: translateY(-1px);
		border-color: color-mix(in oklab, var(--primary) 35%, var(--line-divider));
	}

	.live-report-stat-label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.72rem;
		color: var(--content-meta);
	}

	.live-report-stat-value {
		font-size: 1.2rem;
		font-weight: 700;
		line-height: 1.15;
		color: var(--deep-text);
		font-variant-numeric: tabular-nums;
	}

	.live-report-stat-value small {
		margin-left: 0.15rem;
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--content-meta);
	}

	/* ── 卡片 ──────────────────────────────────────────── */
	.live-report-card {
		padding: 0.9rem;
		border-radius: var(--radius-large, 1rem);
		border: 1px solid var(--line-divider);
		background-color: var(--card-bg);
	}

	.live-report-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.8rem;
	}

	.live-report-card-title {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 1rem;
		font-weight: 700;
		color: var(--deep-text);
	}

	/* 标题装饰：主题色短竖线（原来这里是大图标，去掉更干净） */
	.live-report-card-title::before {
		content: "";
		width: 3px;
		height: 0.95em;
		border-radius: 9999px;
		background-color: var(--primary);
	}

	.live-report-card-desc {
		margin-top: 0.25rem;
		font-size: 0.75rem;
		color: var(--content-meta);
	}

	.live-report-platform-days {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.72rem;
		color: var(--content-meta);
	}

	.live-report-platform-day {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.live-report-platform-day strong {
		color: var(--deep-text);
	}

	.live-report-platform-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
	}

	.live-report-platform-dot.is-bilibili {
		background-color: #fb7299;
	}

	.live-report-platform-dot.is-douyin {
		background-color: #22c9d6;
	}

	.live-report-range {
		font-size: 0.78rem;
		color: var(--content-meta);
	}

	/* ── 选中日详情 ────────────────────────────────────── */
	.live-report-day {
		margin-top: 0.85rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--line-divider);
	}

	.live-report-hint {
		padding: 0.75rem 0;
		text-align: center;
		font-size: 0.78rem;
		color: var(--content-meta);
	}

	.live-report-day-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		font-size: 0.8rem;
	}

	.live-report-day-date {
		font-weight: 700;
		color: var(--deep-text);
		font-variant-numeric: tabular-nums;
	}

	.live-report-day-today {
		padding: 0.05rem 0.4rem;
		border-radius: 9999px;
		background-color: var(--btn-regular-bg);
		color: var(--btn-content);
		font-size: 0.68rem;
	}

	.live-report-day-total {
		color: var(--content-meta);
	}

	.live-report-day-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.live-report-stream {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		padding: 0.5rem 0.65rem;
		border-radius: 0.7rem;
		background-color: var(--btn-regular-bg);
		font-size: 0.78rem;
		color: var(--deep-text);
		transition: background-color 150ms ease;
	}

	.live-report-stream:hover {
		background-color: var(--btn-regular-bg-hover);
	}

	.live-report-stream-platform {
		flex: none;
		padding: 0.05rem 0.4rem;
		border-radius: 9999px;
		font-size: 0.68rem;
		font-weight: 600;
		color: white;
	}

	.live-report-stream-platform.is-bilibili {
		background-color: #fb7299;
	}

	.live-report-stream-platform.is-douyin {
		background-color: #22c9d6;
	}

	.live-report-stream-time {
		flex: none;
		font-variant-numeric: tabular-nums;
		color: var(--content-meta);
	}

	.live-report-stream-title {
		flex: 1 1 10rem;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-report-stream-duration {
		flex: none;
		font-variant-numeric: tabular-nums;
		color: var(--content-meta);
	}

	.live-report-stream-manual {
		flex: none;
		padding: 0.05rem 0.35rem;
		border-radius: 9999px;
		border: 1px solid var(--line-divider);
		font-size: 0.65rem;
		color: var(--content-meta);
	}

	.live-report-stream-link {
		flex: none;
		display: inline-flex;
		color: var(--btn-content);
		opacity: 0.7;
		transition: opacity 150ms ease;
	}

	.live-report-stream-link:hover {
		opacity: 1;
	}

	.live-report-charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 0.75rem;
	}

	@media (min-width: 640px) {
		.live-report-stats {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.live-report-card {
			padding: 1.1rem;
		}
	}

	@media (min-width: 1024px) {
		.live-report-stats {
			grid-template-columns: repeat(6, minmax(0, 1fr));
		}
	}
</style>
