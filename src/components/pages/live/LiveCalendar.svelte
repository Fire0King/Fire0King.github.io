<script lang="ts">
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type { LiveCalendarMonth, LivePlatformId } from "@/types/liveReport";
import {
	formatDuration,
	getWeekdayLabels,
	toClock,
} from "@/utils/live-report-utils";

interface Props {
	calendar: LiveCalendarMonth;
	locale: string;
	weekStart: "monday" | "sunday";
	timezone: string;
	selectedDate: string | null;
	onselect?: (date: string) => void;
}

let { calendar, locale, weekStart, timezone, selectedDate, onselect }: Props =
	$props();

/** 平台品牌色，与站点主题并存（只用于小圆点与描边） */
const PLATFORM_COLORS: Record<LivePlatformId, string> = {
	bilibili: "#fb7299",
	douyin: "#22c9d6",
};

const weekdays = $derived(getWeekdayLabels(locale, weekStart));
const hourUnit = i18n(I18nKey.liveReportHourUnit);
const minuteUnit = i18n(I18nKey.liveReportMinuteUnit);

/** 当月单日最长时长，用于格子底部的热度条 */
const maxDayDuration = $derived(
	calendar.cells.reduce(
		(max, cell) => Math.max(max, cell.summary?.totalDurationSeconds ?? 0),
		0,
	),
);

/** 当月出现过的平台（图例只列这些） */
const monthPlatforms = $derived([
	...new Set(calendar.cells.flatMap((cell) => cell.summary?.platforms ?? [])),
] as LivePlatformId[]);

const hasLiveNow = $derived(
	calendar.cells.some((cell) => cell.summary?.hasActive),
);

function platformLabel(platform: LivePlatformId): string {
	return platform === "bilibili"
		? i18n(I18nKey.liveReportPlatformBilibili)
		: i18n(I18nKey.liveReportPlatformDouyin);
}

/** 格子悬浮提示：日期 + 各场次平台/时段/时长/标题 */
function cellTooltip(date: string): string {
	const cell = calendar.cells.find((item) => item.date === date);
	if (!cell?.summary) return date;
	const detail = cell.summary.streams
		.map((stream) => {
			// 只补录了时长、不知道几点开播的场次不显示时段
			const timePart = stream.timeUnknown
				? ""
				: `${toClock(stream.start, timezone)}-${toClock(stream.end, timezone)} `;
			return `${platformLabel(stream.platform)} ${timePart}${formatDuration(stream.durationSeconds, hourUnit, minuteUnit)}｜${stream.title}`;
		})
		.join("\n");
	return `${date}${cell.summary.hasActive ? `（${i18n(I18nKey.liveReportStreaming)}）` : ""}\n${detail}`;
}
</script>

<div class="live-calendar">
	<div class="live-calendar-grid">
		{#each weekdays as weekday (weekday)}
			<div class="live-calendar-weekday">{weekday}</div>
		{/each}

		{#each calendar.cells as cell (cell.date)}
			{@const summary = cell.summary}
			<button
				type="button"
				class="live-calendar-cell"
				class:is-out={!cell.inMonth}
				class:is-today={cell.isToday}
				class:is-selected={cell.date === selectedDate}
				class:is-future={cell.isFuture}
				class:has-live={Boolean(summary)}
				disabled={!cell.inMonth}
				aria-label={cellTooltip(cell.date)}
				title={cellTooltip(cell.date)}
				onclick={() => onselect?.(cell.date)}
				style={summary
					? `--platform-color: ${PLATFORM_COLORS[summary.platforms[0]]}`
					: undefined}
			>
				<span class="live-calendar-day">
					{cell.day}
					{#if summary?.hasActive}
						<span class="live-calendar-live-dot" aria-hidden="true"></span>
					{/if}
				</span>

				{#if summary}
					<span class="live-calendar-body">
						<span class="live-calendar-platforms">
							{#each summary.platforms as platform (platform)}
								<span
									class="live-calendar-platform-dot"
									style={`background-color: ${PLATFORM_COLORS[platform]}`}
									title={platformLabel(platform)}
								></span>
							{/each}
							<span class="live-calendar-duration">
								{formatDuration(summary.totalDurationSeconds, hourUnit, minuteUnit)}
							</span>
						</span>
						{#if summary.streams[0]?.title}
							<span class="live-calendar-title">{summary.streams[0].title}</span>
						{/if}
					</span>
					{#if maxDayDuration > 0}
						<span
							class="live-calendar-heat"
							style={`width: ${Math.max(
								12,
								Math.round(
									(summary.totalDurationSeconds / maxDayDuration) * 100,
								),
							)}%`}
						></span>
					{/if}
				{/if}
			</button>
		{/each}
	</div>

	<!-- 图例 -->
	<div class="live-calendar-legend">
		{#each monthPlatforms as platform (platform)}
			<span class="live-calendar-legend-item">
				<i
					class="live-calendar-legend-dot"
					style={`background-color: ${PLATFORM_COLORS[platform]}`}
				></i>
				{platformLabel(platform)}
			</span>
		{/each}
		<span class="live-calendar-legend-item">
			<i class="live-calendar-legend-today"></i>
			{i18n(I18nKey.liveReportToday)}
		</span>
		{#if hasLiveNow}
			<span class="live-calendar-legend-item">
				<i class="live-calendar-legend-live"></i>
				{i18n(I18nKey.liveReportStreaming)}
			</span>
		{/if}
	</div>
</div>

<style>
	.live-calendar-grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 0.3rem;
	}

	.live-calendar-weekday {
		padding-bottom: 0.35rem;
		border-bottom: 1px solid var(--line-divider);
		text-align: center;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--content-meta);
	}

	.live-calendar-cell {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 0.2rem;
		min-height: 3.4rem;
		padding: 0.3rem 0.35rem 0.4rem;
		overflow: hidden;
		border: 1px solid transparent;
		border-radius: 0.7rem;
		background-color: color-mix(in oklab, var(--btn-regular-bg) 55%, transparent);
		color: var(--deep-text);
		font-size: 0.75rem;
		line-height: 1.15;
		text-align: left;
		cursor: pointer;
		transition:
			transform 150ms ease,
			box-shadow 150ms ease,
			background-color 150ms ease;
	}

	.live-calendar-cell:disabled {
		cursor: default;
	}

	.live-calendar-cell:not(:disabled):hover {
		transform: translateY(-1px);
		box-shadow: var(--shadow-sm);
	}

	.live-calendar-cell:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.live-calendar-cell.is-out {
		background-color: transparent;
		opacity: 0.3;
	}

	.live-calendar-cell.is-future:not(.has-live) {
		opacity: 0.55;
	}

	.live-calendar-cell.has-live {
		background-color: color-mix(
			in oklab,
			var(--platform-color, var(--primary)) 14%,
			var(--card-bg)
		);
		border-color: color-mix(
			in oklab,
			var(--platform-color, var(--primary)) 35%,
			transparent
		);
	}

	.live-calendar-cell.is-today {
		outline: 1.5px dashed
			color-mix(in oklab, var(--primary) 70%, transparent);
		outline-offset: -2px;
	}

	.live-calendar-cell.is-selected {
		border-color: var(--platform-color, var(--primary));
		box-shadow: 0 0 0 2px
			color-mix(in oklab, var(--platform-color, var(--primary)) 30%, transparent);
	}

	.live-calendar-day {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--content-meta);
	}

	.live-calendar-cell.has-live .live-calendar-day {
		color: var(--deep-text);
	}

	.live-calendar-live-dot {
		display: inline-block;
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
		background-color: #f43f5e;
		animation: live-pulse 1.8s ease-out infinite;
	}

	@keyframes live-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.5);
		}
		70% {
			box-shadow: 0 0 0 0.35rem rgba(244, 63, 94, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(244, 63, 94, 0);
		}
	}

	.live-calendar-body {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.live-calendar-platforms {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		min-width: 0;
	}

	.live-calendar-platform-dot {
		flex: none;
		width: 0.35rem;
		height: 0.35rem;
		border-radius: 9999px;
	}

	.live-calendar-duration {
		min-width: 0;
		font-size: 0.68rem;
		font-variant-numeric: tabular-nums;
		color: var(--content-meta);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.live-calendar-title {
		display: none;
		font-size: 0.66rem;
		color: var(--content-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-calendar-heat {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		border-radius: 9999px;
		background: linear-gradient(
			to right,
			var(--platform-color, var(--primary)),
			color-mix(in oklab, var(--platform-color, var(--primary)) 35%, transparent)
		);
	}

	.live-calendar-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.7rem;
		font-size: 0.68rem;
		color: var(--content-meta);
	}

	.live-calendar-legend-item {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.live-calendar-legend-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
	}

	.live-calendar-legend-today {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 0.15rem;
		border: 1.5px dashed color-mix(in oklab, var(--primary) 70%, transparent);
	}

	.live-calendar-legend-live {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
		background-color: #f43f5e;
	}

	@media (min-width: 640px) {
		.live-calendar-grid {
			gap: 0.4rem;
		}

		.live-calendar-cell {
			min-height: 4.6rem;
			padding: 0.4rem 0.45rem 0.5rem;
			font-size: 0.8rem;
		}

		.live-calendar-title {
			display: block;
		}
	}
</style>
