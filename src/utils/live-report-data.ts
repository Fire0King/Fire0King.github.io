// 直播数据页面：数据装载（构建时读取 JSON + 合并配置里的手动补录）
// 只在 Astro 页面/构建时使用；Svelte 客户端组件请改用 live-report-utils.ts 的纯函数

import { liveReportConfig } from "@/config";
import followersJson from "@/data/live/followers.json";
import streamsJson from "@/data/live/streams.json";
import type {
	FollowersFile,
	LivePlatformId,
	LiveStreamRecord,
	LiveStreamsFile,
} from "@/types/liveReport";
import { toDateKey } from "./live-report-utils";

const streamsFile = streamsJson as unknown as LiveStreamsFile;
const followersFile = followersJson as unknown as FollowersFile;

/** 两条记录是否属于同一场（同平台 + 时间区间重叠或开播时间接近） */
function isSameSession(
	left: LiveStreamRecord,
	right: LiveStreamRecord,
): boolean {
	if (left.platform !== right.platform) return false;
	if (left.id === right.id) return true;
	const leftStart = new Date(left.start).getTime();
	const rightStart = new Date(right.start).getTime();
	if (Number.isNaN(leftStart) || Number.isNaN(rightStart)) return false;
	// 开播时间相差 10 分钟以内视为同一场
	return Math.abs(leftStart - rightStart) <= 10 * 60 * 1000;
}

/** 把配置里的手动补录转成标准记录 */
function normalizeManualRecords(): LiveStreamRecord[] {
	const timeZone = liveReportConfig.timezone;
	const records: LiveStreamRecord[] = [];
	for (const [index, item] of liveReportConfig.manualRecords.entries()) {
		const platform: LivePlatformId = item.platform;
		const hasRange = Boolean(item.start && item.end);
		const durationSeconds = Number(item.durationSeconds);

		// 形式一：给了 start ~ end，按区间算时长
		if (hasRange) {
			const start = new Date(item.start as string);
			const end = new Date(item.end as string);
			if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
				console.warn(
					`[live-report] manualRecords[${index}] 时间格式不正确，已跳过：${item.start} ~ ${item.end}`,
				);
				continue;
			}
			records.push({
				id: `manual-${platform}-${start.toISOString()}`,
				platform,
				title: item.title ?? "",
				date: item.date || toDateKey(start, timeZone),
				start: start.toISOString(),
				end: end.toISOString(),
				durationSeconds: Math.max(
					0,
					Math.round((end.getTime() - start.getTime()) / 1000),
				),
				url: item.url,
				manual: true,
			});
			continue;
		}

		// 形式二：只记得时长（+ 日期）。开播时间用当天 00:00 UTC 占位，只为排序，
		// 页面会靠 timeUnknown 判断不显示时段，绝不瞎编一个开播时间
		if (item.date && Number.isFinite(durationSeconds) && durationSeconds > 0) {
			const start = new Date(`${item.date}T00:00:00Z`);
			if (Number.isNaN(start.getTime())) {
				console.warn(
					`[live-report] manualRecords[${index}] date 格式不正确，已跳过：${item.date}`,
				);
				continue;
			}
			const end = new Date(start.getTime() + durationSeconds * 1000);
			records.push({
				id: `manual-${platform}-${item.date}`,
				platform,
				title: item.title ?? "",
				date: item.date,
				start: start.toISOString(),
				end: end.toISOString(),
				durationSeconds: Math.round(durationSeconds),
				url: item.url,
				manual: true,
				timeUnknown: true,
			});
			continue;
		}

		console.warn(
			`[live-report] manualRecords[${index}] 需要 start+end，或者 date+durationSeconds，已跳过`,
		);
	}
	return records;
}

/** 读取直播场次数据（自动采集 + 手动补录，按开始时间升序） */
export function getLiveStreams(): LiveStreamsFile {
	const autoRecords = streamsFile.records ?? [];
	const manualRecords = normalizeManualRecords().filter(
		(manual) => !autoRecords.some((auto) => isSameSession(auto, manual)),
	);
	const records = [...autoRecords, ...manualRecords].sort((left, right) =>
		left.start.localeCompare(right.start),
	);
	return {
		version: streamsFile.version ?? 1,
		updatedAt: streamsFile.updatedAt ?? null,
		timezone: streamsFile.timezone || liveReportConfig.timezone,
		intervalMinutes:
			streamsFile.intervalMinutes || liveReportConfig.collector.intervalMinutes,
		active: streamsFile.active ?? {},
		records,
	};
}

/** 读取粉丝快照数据 */
export function getFollowers(): FollowersFile {
	return {
		version: followersFile.version ?? 1,
		updatedAt: followersFile.updatedAt ?? null,
		series: followersFile.series ?? {},
	};
}

/** 所有出现过数据的日期（用于生成月份选项） */
export function getDataDates(
	streams: LiveStreamsFile,
	followers: FollowersFile,
): string[] {
	const dates = new Set<string>();
	for (const record of streams.records) {
		if (record.date) dates.add(record.date);
	}
	for (const platform of Object.keys(followers.series)) {
		const series = followers.series[platform as LivePlatformId];
		for (const point of series?.points ?? []) {
			if (point.date) dates.add(point.date);
		}
	}
	return [...dates].sort();
}

/** 数据覆盖范围，没有任何数据时返回 null */
export function getDataRange(
	streams: LiveStreamsFile,
	followers: FollowersFile,
): { first: string; last: string } | null {
	const dates = getDataDates(streams, followers);
	if (dates.length === 0) return null;
	return { first: dates[0], last: dates[dates.length - 1] };
}

/** 最近一次数据更新时间（取两个文件的较大值） */
export function getLastUpdatedAt(
	streams: LiveStreamsFile,
	followers: FollowersFile,
): string | null {
	const values = [streams.updatedAt, followers.updatedAt].filter(
		(value): value is string => Boolean(value),
	);
	if (values.length === 0) return null;
	return values.sort()[values.length - 1];
}
