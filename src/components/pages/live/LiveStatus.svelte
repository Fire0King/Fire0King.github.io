<script lang="ts">
/**
 * 实时直播状态卡片。
 *
 * 数据来自服务器上的 live-status-poller（每 30 秒查一次 B 站接口，写到 /api/live-status.json），
 * 页面每 20 秒取一次 —— 不依赖 GitHub Actions 的调度，所以"是否在播"是分钟级的。
 *
 * 取不到（404 / 网络错误 / 服务器没装轮询器）时整块不渲染，页面表现与之前完全一致。
 */
import { onMount } from "svelte";
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import LiveIcon from "./LiveIcon.svelte";

interface PlatformLive {
	live: boolean;
	status: number;
	title: string;
	online: number;
	followers: number;
	startedAt: string;
	area: string;
}

interface LiveStatusFile {
	updatedAt: string;
	roomUrl?: string;
	roomId?: string;
	bilibili?: PlatformLive;
}

interface Props {
	timezone?: string;
	intervalMs?: number;
}

let { timezone = "Asia/Shanghai", intervalMs = 20000 }: Props = $props();

let data = $state<LiveStatusFile | null>(null);
let clock = $state("");

const endpoint = `${import.meta.env.BASE_URL}api/live-status.json`;

function formatClock(iso: string): string {
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: timezone,
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).format(new Date(iso));
	} catch {
		return "";
	}
}

function formatStarted(value: string): string {
	// 接口给的是 "2026-09-30 19:12:00"（北京时间），取时分即可
	const m = value.match(/(\d{2}):(\d{2})/);
	return m ? `${m[1]}:${m[2]}` : "";
}

async function refresh(): Promise<void> {
	try {
		const res = await fetch(endpoint, { cache: "no-store" });
		if (!res.ok) return;
		const json = (await res.json()) as LiveStatusFile;
		if (!json?.bilibili) return;
		data = json;
		clock = formatClock(json.updatedAt);
	} catch {
		// 静默降级：没有轮询器时页面照常显示构建出来的数据
	}
}

onMount(() => {
	void refresh();
	const timer = setInterval(() => void refresh(), intervalMs);
	const onVisible = () => {
		if (document.visibilityState === "visible") void refresh();
	};
	document.addEventListener("visibilitychange", onVisible);
	return () => {
		clearInterval(timer);
		document.removeEventListener("visibilitychange", onVisible);
	};
});
</script>

{#if data?.bilibili}
	{@const b = data.bilibili}
	<div class="live-status" class:is-live={b.live}>
		<div class="live-status-head">
			<span class="live-status-title">
				<LiveIcon name="broadcast" class="h-4 w-4" />
				{i18n(I18nKey.liveStatusTitle)}
			</span>
			<span class="live-status-time">
				{i18n(I18nKey.liveReportLastUpdated)} {clock}
			</span>
		</div>

		<div class="live-status-body">
			<span class="live-status-platform">
				{i18n(I18nKey.liveReportPlatformBilibili)}
			</span>

			<span class="live-status-state">
				{#if b.live}
					<span class="live-status-dot"></span>
					{i18n(I18nKey.liveReportStreaming)}
				{:else}
					{i18n(I18nKey.liveStatusOffline)}
				{/if}
			</span>

			{#if b.live && b.online > 0}
				<span class="live-status-metric">
					<LiveIcon name="users" class="h-3.5 w-3.5" />
					{i18n(I18nKey.liveStatusViewers)} {b.online.toLocaleString()}
				</span>
			{/if}

			<span class="live-status-metric">
				<LiveIcon name="star" class="h-3.5 w-3.5" />
				{i18n(I18nKey.liveReportFollowerTotal)} {b.followers.toLocaleString()}
			</span>

			{#if b.live && b.startedAt}
				<span class="live-status-metric">
					<LiveIcon name="clock" class="h-3.5 w-3.5" />
					{formatStarted(b.startedAt)}
				</span>
			{/if}

			{#if b.live && data.roomUrl}
				<a
					class="live-status-link"
					href={data.roomUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					{i18n(I18nKey.liveReportOpenRoom)}
					<LiveIcon name="external" class="h-3.5 w-3.5" />
				</a>
			{/if}
		</div>

		{#if b.live && b.title}
			<p class="live-status-name">{b.title}</p>
		{/if}
	</div>
{/if}

<style>
	.live-status {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.9rem;
		background-color: var(--card-bg);
	}

	/* 在播时给一条醒目的左侧色带 + 呼吸点 */
	.live-status.is-live {
		border-color: color-mix(in oklab, #f43f5e 45%, var(--line-divider));
		background-image: linear-gradient(
			90deg,
			rgba(244, 63, 94, 0.1),
			transparent 55%
		);
	}

	.live-status-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.live-status-title {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--deep-text);
	}

	.live-status-time {
		font-size: 0.72rem;
		color: var(--content-meta);
		font-variant-numeric: tabular-nums;
	}

	.live-status-body {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem 0.9rem;
		font-size: 0.82rem;
		color: var(--content-meta);
	}

	.live-status-platform {
		padding: 0.05rem 0.45rem;
		border-radius: 9999px;
		background-color: var(--btn-regular-bg);
		font-weight: 600;
		color: var(--btn-content);
	}

	.live-status-state {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-weight: 600;
		color: var(--deep-text);
	}

	.live-status.is-live .live-status-state {
		color: #e11d48;
	}

	:global(.dark) .live-status.is-live .live-status-state {
		color: oklch(0.75 0.16 15);
	}

	.live-status-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 9999px;
		background-color: #f43f5e;
		animation: live-status-pulse 1.8s ease-out infinite;
	}

	@keyframes live-status-pulse {
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

	.live-status-metric {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-variant-numeric: tabular-nums;
	}

	.live-status-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-weight: 600;
		color: var(--primary);
		text-decoration: none;
	}

	.live-status-link:hover {
		text-decoration: underline;
	}

	.live-status-name {
		font-size: 0.8rem;
		color: var(--deep-text);
		opacity: 0.85;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
