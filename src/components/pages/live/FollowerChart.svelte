<script lang="ts">
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type { FollowerChartSeries, LivePlatformId } from "@/types/liveReport";
import { formatNumber, formatSigned } from "@/utils/live-report-utils";
import LiveIcon from "./LiveIcon.svelte";

interface Props {
	series: FollowerChartSeries;
	locale: string;
}

let { series, locale }: Props = $props();

/** 悬浮的数据点下标 */
let hoveredIndex = $state<number | null>(null);

const PLATFORM_COLORS: Record<LivePlatformId, string> = {
	bilibili: "#fb7299",
	douyin: "#22c9d6",
};

const points = $derived(series.points);
/** 纵轴基准：取区间内最大增幅/降幅的绝对值，至少为 1 避免除零 */
const scale = $derived(Math.max(series.maxDelta, Math.abs(series.minDelta), 1));
/** 横轴标签抽稀步长，避免拥挤 */
const labelStep = $derived(Math.max(1, Math.ceil(points.length / 8)));
/** 是否已经有两天的数据可以用来算增减 */
const hasDeltas = $derived(points.some((point) => point.delta !== null));

const hovered = $derived(
	hoveredIndex === null ? null : (points[hoveredIndex] ?? null),
);

function platformLabel(platform: LivePlatformId): string {
	return platform === "bilibili"
		? i18n(I18nKey.liveReportPlatformBilibili)
		: i18n(I18nKey.liveReportPlatformDouyin);
}

/** 柱子高度：占半轴高度的百分比 */
function barHeight(delta: number | null): number {
	if (!delta) return 0;
	return Math.max(4, Math.round((Math.abs(delta) / scale) * 100));
}

/** 日期 2026-02-14 -> 02-14 */
function shortDate(date: string): string {
	return date.slice(5);
}
</script>

<div class="follower-chart">
	<!-- 头部：平台 + 当前粉丝 + 区间净增 -->
	<div class="follower-chart-head">
		<div class="follower-chart-platform">
			<span
				class="follower-chart-badge"
				style={`background-color: ${PLATFORM_COLORS[series.platform]}`}
			></span>
			<span class="follower-chart-name">
				{series.name || platformLabel(series.platform)}
			</span>
			<span class="follower-chart-tag">{platformLabel(series.platform)}</span>
		</div>
		<div class="follower-chart-metrics">
			<span class="follower-chart-metric">
				<span class="follower-chart-metric-label">
					{i18n(I18nKey.liveReportFollowerTotal)}
				</span>
				<span class="follower-chart-metric-value">
					{formatNumber(series.total, locale)}
				</span>
			</span>
			<span class="follower-chart-metric">
				<span class="follower-chart-metric-label">
					{i18n(I18nKey.liveReportNetChange)}
				</span>
				<span
					class="follower-chart-metric-value"
					class:is-up={series.netChange > 0}
					class:is-down={series.netChange < 0}
				>
					{#if series.netChange > 0}
						<LiveIcon name="arrowUp" class="h-3.5 w-3.5" />
					{:else if series.netChange < 0}
						<LiveIcon name="arrowDown" class="h-3.5 w-3.5" />
					{/if}
					{formatSigned(series.netChange, locale)}
				</span>
			</span>
		</div>
	</div>

	{#if points.length > 0}
		<div class="follower-chart-plot">
			<!-- 纵轴刻度：+最大增幅 / 0 / 最大降幅 -->
			<div class="follower-chart-axis" aria-hidden="true">
				<span class="follower-chart-axis-top">
					{series.maxDelta > 0 ? `+${formatNumber(series.maxDelta, locale)}` : ""}
				</span>
				<span class="follower-chart-axis-zero">0</span>
				<span class="follower-chart-axis-bottom">
					{series.minDelta < 0 ? formatNumber(series.minDelta, locale) : ""}
				</span>
			</div>

			<div class="follower-chart-main">
				<div
					class="follower-chart-bars"
					onmouseleave={() => (hoveredIndex = null)}
				>
					<div class="follower-chart-axis-line" aria-hidden="true"></div>
					{#each points as point, index (point.date)}
						<button
							type="button"
							class="follower-chart-col"
							aria-label={`${point.date} ${formatSigned(point.delta ?? 0, locale)}`}
							onmouseenter={() => (hoveredIndex = index)}
							onfocus={() => (hoveredIndex = index)}
							onblur={() => (hoveredIndex = null)}
							onclick={() =>
								(hoveredIndex = hoveredIndex === index ? null : index)}
						>
							<span class="follower-chart-half is-up">
								{#if point.delta !== null && point.delta > 0}
									<span
										class="follower-chart-bar is-up"
										style={`height: ${barHeight(point.delta)}%`}
									></span>
								{/if}
							</span>
							<span class="follower-chart-half is-down">
								{#if point.delta !== null && point.delta < 0}
									<span
										class="follower-chart-bar is-down"
										style={`height: ${barHeight(point.delta)}%`}
									></span>
								{/if}
							</span>
						</button>
					{/each}

					{#if hovered !== null && hoveredIndex !== null}
						<div
							class="follower-chart-tooltip"
							style={`left: ${((hoveredIndex + 0.5) / points.length) * 100}%`}
						>
							<div class="follower-chart-tooltip-date">{hovered.date}</div>
							<div class="follower-chart-tooltip-row">
								<span>{i18n(I18nKey.liveReportFollowerTotal)}</span>
								<strong>{formatNumber(hovered.total, locale)}</strong>
							</div>
							<div
								class="follower-chart-tooltip-row"
								class:is-up={(hovered.delta ?? 0) > 0}
								class:is-down={(hovered.delta ?? 0) < 0}
							>
								<span>
									{(hovered.delta ?? 0) > 0
										? i18n(I18nKey.liveReportIncrease)
										: (hovered.delta ?? 0) < 0
											? i18n(I18nKey.liveReportDecrease)
											: i18n(I18nKey.liveReportBaseline)}
								</span>
								<strong>
									{hovered.delta === null
										? i18n(I18nKey.liveReportBaseline)
										: formatSigned(hovered.delta, locale)}
								</strong>
							</div>
						</div>
					{/if}
				</div>

				<!-- 横轴日期 -->
				<div class="follower-chart-labels">
					{#each points as point, index (point.date)}
						<span class="follower-chart-label">
							{index % labelStep === 0 || index === points.length - 1
								? shortDate(point.date)
								: ""}
						</span>
					{/each}
				</div>

				<!-- 图例 / 提示 -->
				<div class="follower-chart-legend">
					<span class="follower-chart-legend-item">
						<i class="follower-chart-legend-dot is-up"></i>
						{i18n(I18nKey.liveReportIncrease)}
					</span>
					<span class="follower-chart-legend-item">
						<i class="follower-chart-legend-dot is-down"></i>
						{i18n(I18nKey.liveReportDecrease)}
					</span>
					{#if !hasDeltas}
						<span class="follower-chart-legend-note">
							{i18n(I18nKey.liveReportFollowerBaselineHint)}
						</span>
					{/if}
				</div>
			</div>
		</div>
	{:else}
		<div class="follower-chart-empty">
			{i18n(I18nKey.liveReportNoFollowerData)}
		</div>
	{/if}
</div>

<style>
	.follower-chart {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.85rem 0.9rem 0.7rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.95rem;
		background-color: var(--btn-plain-bg-active);
	}

	.follower-chart-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
	}

	.follower-chart-platform {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.follower-chart-badge {
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
	}

	.follower-chart-name {
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--deep-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.follower-chart-tag {
		flex: none;
		padding: 0.05rem 0.4rem;
		border-radius: 9999px;
		background-color: var(--btn-regular-bg);
		font-size: 0.68rem;
		color: var(--content-meta);
	}

	.follower-chart-metrics {
		display: flex;
		align-items: center;
		gap: 0.9rem;
	}

	.follower-chart-metric {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
	}

	.follower-chart-metric-label {
		font-size: 0.7rem;
		color: var(--content-meta);
	}

	.follower-chart-metric-value {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		font-size: 0.95rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--deep-text);
	}

	.follower-chart-metric-value.is-up {
		color: oklch(0.62 0.15 155);
	}

	.follower-chart-metric-value.is-down {
		color: oklch(0.6 0.19 20);
	}

	/* 暗色下卡片本身是深色，涨跌色要提亮才看得清（oklch 0.6 在深底上只有 ~4.5，红绿都偏暗） */
	:global(.dark) .follower-chart-metric-value.is-up,
	:global(.dark) .follower-chart-tooltip-row.is-up strong {
		color: oklch(0.78 0.15 155);
	}

	:global(.dark) .follower-chart-metric-value.is-down,
	:global(.dark) .follower-chart-tooltip-row.is-down strong {
		color: oklch(0.74 0.17 20);
	}

	/* 纵轴刻度 + 图表主体 */
	.follower-chart-plot {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.4rem;
	}

	.follower-chart-axis {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		height: 9.5rem;
		padding-bottom: 0.1rem;
		font-size: 0.62rem;
		font-variant-numeric: tabular-nums;
		color: var(--content-meta);
		text-align: right;
	}

	.follower-chart-axis-zero {
		opacity: 0.7;
	}

	.follower-chart-main {
		min-width: 0;
	}

	.follower-chart-bars {
		position: relative;
		display: flex;
		align-items: stretch;
		gap: 2px;
		height: 9.5rem;
	}

	.follower-chart-axis-line {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 1px;
		background-color: var(--line-divider);
	}

	.follower-chart-col {
		position: relative;
		z-index: 1;
		flex: 1 1 0;
		display: flex;
		flex-direction: column;
		min-width: 2px;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
		border-radius: 0.2rem;
	}

	.follower-chart-col:hover {
		background-color: color-mix(in oklab, var(--primary) 8%, transparent);
	}

	.follower-chart-col:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.follower-chart-half {
		display: flex;
		width: 100%;
		height: 50%;
	}

	.follower-chart-half.is-up {
		align-items: flex-end;
	}

	.follower-chart-half.is-down {
		align-items: flex-start;
	}

	.follower-chart-bar {
		display: block;
		width: 100%;
		border-radius: 0.2rem;
		transition: filter 150ms ease;
	}

	.follower-chart-bar.is-up {
		background: linear-gradient(
			to top,
			color-mix(in oklab, oklch(0.62 0.15 155) 55%, transparent),
			oklch(0.62 0.15 155)
		);
	}

	.follower-chart-bar.is-down {
		background: linear-gradient(
			to bottom,
			color-mix(in oklab, oklch(0.6 0.19 20) 55%, transparent),
			oklch(0.6 0.19 20)
		);
	}

	.follower-chart-col:hover .follower-chart-bar {
		filter: brightness(1.1) saturate(1.15);
	}

	.follower-chart-labels {
		display: flex;
		gap: 2px;
		padding-top: 0.2rem;
	}

	.follower-chart-label {
		flex: 1 1 0;
		min-width: 0;
		text-align: center;
		font-size: 0.62rem;
		font-variant-numeric: tabular-nums;
		color: var(--content-meta);
		white-space: nowrap;
	}

	.follower-chart-tooltip {
		position: absolute;
		bottom: calc(100% + 0.3rem);
		z-index: 5;
		min-width: 7.5rem;
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.6rem;
		background-color: var(--float-panel-bg);
		box-shadow: var(--shadow-md);
		font-size: 0.72rem;
		color: var(--deep-text);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.follower-chart-tooltip-date {
		margin-bottom: 0.15rem;
		font-weight: 600;
		color: var(--content-meta);
	}

	.follower-chart-tooltip-row {
		display: flex;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.follower-chart-tooltip-row.is-up strong {
		color: oklch(0.62 0.15 155);
	}

	.follower-chart-tooltip-row.is-down strong {
		color: oklch(0.6 0.19 20);
	}

	.follower-chart-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.3rem;
		font-size: 0.68rem;
		color: var(--content-meta);
	}

	.follower-chart-legend-item {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.follower-chart-legend-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 0.15rem;
	}

	.follower-chart-legend-dot.is-up {
		background-color: oklch(0.62 0.15 155);
	}

	.follower-chart-legend-dot.is-down {
		background-color: oklch(0.6 0.19 20);
	}

	.follower-chart-legend-note {
		margin-left: auto;
		opacity: 0.85;
	}

	.follower-chart-empty {
		margin-top: 0.35rem;
		padding: 2rem 0;
		border: 1px dashed var(--line-divider);
		border-radius: 0.7rem;
		text-align: center;
		font-size: 0.78rem;
		color: var(--content-meta);
	}
</style>
