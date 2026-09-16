// 直播数据页面：纯计算工具
// 这个文件不导入任何 JSON 数据，可以被 Svelte 客户端组件安全引用
// （数据由 Astro 页面在构建时装载后以 props 传入，避免把数据打包两份）

import type {
	FollowerChartSeries,
	FollowerDeltaPoint,
	FollowersFile,
	LiveActiveStream,
	LiveCalendarCell,
	LiveCalendarMonth,
	LiveDaySummary,
	LiveMonthOption,
	LiveMonthStats,
	LivePlatformId,
	LiveStreamRecord,
} from "@/types/liveReport";

/** 月历构建参数 */
export type LiveCalendarOptions = {
	/** 一周起始日 */
	weekStart: "monday" | "sunday";
	/** 今天的日期键 YYYY-MM-DD（按配置时区） */
	todayKey: string;
	/** 平台筛选，all 表示全部平台 */
	platform: LivePlatformId | "all";
	/** 统计时区，用于把"正在直播"的开播时间换算成日期键 */
	timezone: string;
	/** 当前正在直播的场次（用于月历上的"直播中"标记） */
	activeStreams?: LiveActiveStream[];
};

/** 语言代码到 Intl locale 的映射（与站点语言保持一致） */
const LOCALE_MAP: Record<string, string> = {
	zh_CN: "zh-CN",
	zh_TW: "zh-TW",
	en: "en-US",
	ja: "ja-JP",
	ko: "ko-KR",
	ru: "ru-RU",
};

/** 取得当前站点语言对应的 Intl locale */
export function getLiveReportLocale(lang: string): string {
	return LOCALE_MAP[lang] || "en-US";
}

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateKeyFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = dateKeyFormatters.get(timeZone);
	if (cached) return cached;
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	dateKeyFormatters.set(timeZone, formatter);
	return formatter;
}

function formatParts(
	date: Date,
	timeZone: string,
	options: Intl.DateTimeFormatOptions,
): Record<string, string> {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		...options,
	}).formatToParts(date);
	const result: Record<string, string> = {};
	for (const part of parts) {
		if (part.type !== "literal") result[part.type] = part.value;
	}
	return result;
}

/** 把时间字符串转换为配置时区下的日期键 YYYY-MM-DD */
export function toDateKey(value: string | Date, timeZone: string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) return "";
	const parts = formatParts(date, timeZone, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 把时间字符串转换为配置时区下的时刻 HH:mm */
export function toClock(value: string | Date, timeZone: string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) return "";
	const parts = formatParts(date, timeZone, {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return `${parts.hour}:${parts.minute}`;
}

/** 取得今天（配置时区）的日期键 */
export function getTodayKey(timeZone: string): string {
	return getDateKeyFormatter(timeZone).format(new Date());
}

/** 从日期键取出月份键 YYYY-MM */
export function getMonthKeyOf(dateKey: string): string {
	return dateKey.slice(0, 7);
}

/** 月份键加减若干个月 */
export function shiftMonthKey(monthKey: string, delta: number): string {
	const [year, month] = monthKey.split("-").map(Number);
	const total = year * 12 + (month - 1) + delta;
	const nextYear = Math.floor(total / 12);
	const nextMonth = (total % 12) + 1;
	return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

/** 日期键加减若干天（基于 UTC 运算，不受本地时区影响） */
export function shiftDateKey(dateKey: string, delta: number): string {
	const [year, month, day] = dateKey.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + delta));
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** 日期键对应的星期（0=周日） */
export function getWeekdayOf(dateKey: string): number {
	const [year, month, day] = dateKey.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 月份键对应的天数 */
export function getDaysInMonth(monthKey: string): number {
	const [year, month] = monthKey.split("-").map(Number);
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 月份展示文案，如 2026年2月 / Feb 2026 */
export function formatMonthLabel(monthKey: string, locale: string): string {
	const [year, month] = monthKey.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, 1, 12));
	return new Intl.DateTimeFormat(locale, {
		timeZone: "UTC",
		year: "numeric",
		month: "long",
	}).format(date);
}

/** 星期表头文案，按 weekStart 排列 */
export function getWeekdayLabels(
	locale: string,
	weekStart: "monday" | "sunday",
): string[] {
	const formatter = new Intl.DateTimeFormat(locale, {
		timeZone: "UTC",
		weekday: "short",
	});
	// 2024-01-01 是周一
	const labels: string[] = [];
	for (let index = 0; index < 7; index += 1) {
		const date = new Date(Date.UTC(2024, 0, 1 + index, 12));
		labels.push(formatter.format(date));
	}
	return weekStart === "sunday" ? [labels[6], ...labels.slice(0, 6)] : labels;
}

/** 时长格式化，如 3小时12分钟 / 45分钟 */
export function formatDuration(
	seconds: number,
	hourUnit: string,
	minuteUnit: string,
): string {
	const totalMinutes = Math.max(0, Math.round(seconds / 60));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours <= 0) return `${minutes}${minuteUnit}`;
	if (minutes <= 0) return `${hours}${hourUnit}`;
	return `${hours}${hourUnit}${minutes}${minuteUnit}`;
}

/** 时长格式化（紧凑形式，图表/角标用），如 3.2h / 45m */
export function formatDurationCompact(seconds: number): string {
	const totalMinutes = Math.max(0, Math.round(seconds / 60));
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = totalMinutes / 60;
	return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}h`;
}

/** 数字格式化：1234 -> 1,234 */
export function formatNumber(value: number, locale: string): string {
	return new Intl.NumberFormat(locale).format(value);
}

/** 带符号的数字：+12 / -3 / 0 */
export function formatSigned(value: number, locale: string): string {
	const formatted = formatNumber(Math.abs(value), locale);
	if (value > 0) return `+${formatted}`;
	if (value < 0) return `-${formatted}`;
	return "0";
}

/** 按平台筛选场次 */
export function filterByPlatform(
	records: LiveStreamRecord[],
	platform: LivePlatformId | "all",
): LiveStreamRecord[] {
	if (platform === "all") return records;
	return records.filter((record) => record.platform === platform);
}

/** 按日期聚合场次 */
export function groupStreamsByDate(
	records: LiveStreamRecord[],
): Map<string, LiveStreamRecord[]> {
	const map = new Map<string, LiveStreamRecord[]>();
	for (const record of records) {
		const list = map.get(record.date);
		if (list) list.push(record);
		else map.set(record.date, [record]);
	}
	return map;
}

/** 汇总某一天的直播情况 */
export function summarizeDay(
	date: string,
	streams: LiveStreamRecord[],
	activeDates: Map<LivePlatformId, string>,
): LiveDaySummary {
	const platforms = [
		...new Set(streams.map((stream) => stream.platform)),
	] as LivePlatformId[];
	return {
		date,
		streams: [...streams].sort((a, b) => a.start.localeCompare(b.start)),
		totalDurationSeconds: streams.reduce(
			(sum, stream) => sum + (stream.durationSeconds || 0),
			0,
		),
		platforms,
		// 只有"当前正在直播的那一场"所在的那天才算直播中
		hasActive: streams.some(
			(stream) => activeDates.get(stream.platform) === date,
		),
	};
}

/** 计算月度统计（streak 基于传入的全部日期，不受月份限制） */
export function buildMonthStats(
	days: LiveDaySummary[],
	allLiveDates: string[],
): LiveMonthStats {
	const streamCount = days.reduce((sum, day) => sum + day.streams.length, 0);
	const totalDurationSeconds = days.reduce(
		(sum, day) => sum + day.totalDurationSeconds,
		0,
	);
	const longestDurationSeconds = days.reduce(
		(max, day) =>
			Math.max(max, ...day.streams.map((s) => s.durationSeconds), 0),
		0,
	);
	const platformDays: Record<LivePlatformId, number> = {
		bilibili: 0,
		douyin: 0,
	};
	for (const day of days) {
		for (const platform of day.platforms) {
			platformDays[platform] += 1;
		}
	}
	return {
		liveDays: days.length,
		streamCount,
		totalDurationSeconds,
		averageDurationSeconds:
			streamCount > 0 ? Math.round(totalDurationSeconds / streamCount) : 0,
		longestDurationSeconds,
		streakDays: computeStreak(allLiveDates),
		platformDays,
	};
}

/** 计算连续直播天数：从最近一次直播往前数，断档即停止 */
export function computeStreak(liveDates: string[]): number {
	if (liveDates.length === 0) return 0;
	const unique = [...new Set(liveDates)].sort();
	let streak = 1;
	let cursor = unique[unique.length - 1];
	for (let index = unique.length - 2; index >= 0; index -= 1) {
		const expected = shiftDateKey(cursor, -1);
		if (unique[index] !== expected) break;
		streak += 1;
		cursor = unique[index];
	}
	return streak;
}

/** 构建某个平台的粉丝增减序列（delta 与前一个快照比较，可跨月） */
export function buildFollowerSeries(
	platform: LivePlatformId,
	followers: FollowersFile,
	monthKey: string,
): FollowerChartSeries {
	const series = followers.series[platform];
	const allPoints = [...(series?.points ?? [])].sort((a, b) =>
		a.date.localeCompare(b.date),
	);

	const withDelta: FollowerDeltaPoint[] = allPoints.map((point, index) => {
		const previous = index > 0 ? allPoints[index - 1] : undefined;
		return {
			date: point.date,
			total: point.total,
			delta: previous ? point.total - previous.total : null,
			isBaseline: !previous,
		};
	});

	const points = withDelta.filter(
		(point) => getMonthKeyOf(point.date) === monthKey,
	);
	const deltas = points
		.map((point) => point.delta)
		.filter((delta): delta is number => delta !== null);

	return {
		platform,
		name: series?.name,
		total: series?.total ?? 0,
		netChange: deltas.reduce((sum, delta) => sum + delta, 0),
		points,
		maxDelta: deltas.reduce((max, delta) => Math.max(max, delta), 0),
		minDelta: deltas.reduce((min, delta) => Math.min(min, delta), 0),
	};
}

/** 构建月历（含上下月补齐的单元格与月度统计） */
export function buildCalendarMonth(
	monthKey: string,
	records: LiveStreamRecord[],
	options: LiveCalendarOptions,
): LiveCalendarMonth {
	const filtered = filterByPlatform(records, options.platform);
	const monthRecords = filtered.filter(
		(record) => getMonthKeyOf(record.date) === monthKey,
	);
	const byDate = groupStreamsByDate(monthRecords);

	const activeDates = new Map<LivePlatformId, string>();
	for (const stream of options.activeStreams ?? []) {
		const key = toDateKey(stream.start, options.timezone);
		if (key) activeDates.set(stream.platform, key);
	}

	const daysInMonth = getDaysInMonth(monthKey);
	const firstDateKey = `${monthKey}-01`;
	const firstWeekday = getWeekdayOf(firstDateKey);
	const weekStartOffset = options.weekStart === "monday" ? 1 : 0;
	const leading = (firstWeekday - weekStartOffset + 7) % 7;
	const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;

	const cells: LiveCalendarCell[] = [];
	for (let index = 0; index < totalCells; index += 1) {
		const dateKey = shiftDateKey(firstDateKey, index - leading);
		const inMonth = dateKey.startsWith(monthKey);
		const streams = byDate.get(dateKey);
		cells.push({
			date: dateKey,
			day: Number(dateKey.slice(8, 10)),
			inMonth,
			isToday: dateKey === options.todayKey,
			isFuture: dateKey > options.todayKey,
			summary: streams
				? summarizeDay(dateKey, streams, activeDates)
				: undefined,
		});
	}

	const days = [...byDate.entries()]
		.map(([date, streams]) => summarizeDay(date, streams, activeDates))
		.sort((a, b) => a.date.localeCompare(b.date));

	const allLiveDates = [
		...new Set(filtered.map((record) => record.date)),
	].sort();

	return {
		month: monthKey,
		daysInMonth,
		cells,
		stats: buildMonthStats(days, allLiveDates),
	};
}

/** 构建月份选项列表（从最早数据到当前月份，新的在前） */
export function buildMonthOptions(
	dates: string[],
	todayKey: string,
	locale: string,
): LiveMonthOption[] {
	const currentMonth = getMonthKeyOf(todayKey);
	const months = new Set<string>([currentMonth]);
	for (const date of dates) {
		if (date) months.add(getMonthKeyOf(date));
	}
	const sorted = [...months].sort().reverse();
	return sorted.map((key) => ({
		key,
		label: formatMonthLabel(key, locale),
		hasData: dates.some((date) => getMonthKeyOf(date) === key),
	}));
}
