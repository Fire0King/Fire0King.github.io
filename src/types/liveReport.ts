// 直播报表数据类型
// 数据文件：src/data/live/streams.json（直播场次）、src/data/live/followers.json（粉丝快照）
// 由 scripts/live-data/collect.mjs 定时写入

import type { LivePlatformId } from "./liveReportConfig";

export type { LivePlatformId };

/** 一场直播（已结束） */
export type LiveStreamRecord = {
	/** 唯一 ID，形如 bilibili-2026-02-14T20:00:00+08:00 */
	id: string;
	/** 平台 */
	platform: LivePlatformId;
	/** 当天的直播标题 */
	title: string;
	/** 归属日期 YYYY-MM-DD（按配置时区，取开播日，跨天场次归到开播当天） */
	date: string;
	/** 开始时间 ISO 字符串（带时区偏移） */
	start: string;
	/** 结束时间 ISO 字符串（带时区偏移） */
	end: string;
	/** 时长（秒） */
	durationSeconds: number;
	/** 直播间/回放地址 */
	url?: string;
	/** 直播间号 */
	roomId?: string;
	/** 直播封面 */
	cover?: string;
	/** true 表示这条记录来自配置里的手动补录 */
	manual?: boolean;
};

/** 正在直播的场次（还没结束） */
export type LiveActiveStream = {
	platform: LivePlatformId;
	title: string;
	/** 开播时间 ISO 字符串 */
	start: string;
	/** 最近一次标题更新的时间（抓取脚本用于节流，避免频繁提交） */
	titleUpdatedAt?: string;
	url?: string;
	roomId?: string;
	cover?: string;
};

/** streams.json 文件结构 */
export type LiveStreamsFile = {
	/** 数据结构版本 */
	version: number;
	/** 最近一次写入时间 */
	updatedAt: string | null;
	/** 数据使用的时区 */
	timezone: string;
	/** 轮询间隔（分钟） */
	intervalMinutes: number;
	/** 当前正在直播的场次，按平台区分 */
	active: Partial<Record<LivePlatformId, LiveActiveStream>>;
	/** 历史场次，按开始时间升序 */
	records: LiveStreamRecord[];
};

/** 粉丝数快照点 */
export type FollowerPoint = {
	/** 日期 YYYY-MM-DD */
	date: string;
	/** 当日粉丝总数 */
	total: number;
};

/** 单个平台的粉丝数据 */
export type FollowerPlatformSeries = {
	/** 账号昵称 */
	name?: string;
	/** 最新粉丝总数 */
	total: number;
	/** 最近一次写入快照的时间 ISO 字符串（由抓取脚本维护，用于控制写入频率） */
	snapshotAt?: string;
	/** 每日快照，按日期升序 */
	points: FollowerPoint[];
};

/** followers.json 文件结构 */
export type FollowersFile = {
	/** 数据结构版本 */
	version: number;
	/** 最近一次写入时间 */
	updatedAt: string | null;
	/** 各平台粉丝数据 */
	series: Partial<Record<LivePlatformId, FollowerPlatformSeries>>;
};

// ── 页面视图模型 ──────────────────────────────────────────────

/** 某一天的直播汇总 */
export type LiveDaySummary = {
	date: string;
	/** 当天的场次（可多场、可多平台） */
	streams: LiveStreamRecord[];
	/** 当天直播总时长（秒） */
	totalDurationSeconds: number;
	/** 当天开播过的平台 */
	platforms: LivePlatformId[];
	/** 当天是否仍在直播 */
	hasActive: boolean;
};

/** 月历单元格 */
export type LiveCalendarCell = {
	/** YYYY-MM-DD */
	date: string;
	/** 几号 */
	day: number;
	/** 是否属于当前月份 */
	inMonth: boolean;
	/** 是否今天 */
	isToday: boolean;
	/** 是否未来日期 */
	isFuture: boolean;
	/** 当天的直播汇总，没直播则为 undefined */
	summary?: LiveDaySummary;
};

/** 月度统计 */
export type LiveMonthStats = {
	/** 有直播的天数 */
	liveDays: number;
	/** 场次数量 */
	streamCount: number;
	/** 总时长（秒） */
	totalDurationSeconds: number;
	/** 平均每场时长（秒） */
	averageDurationSeconds: number;
	/** 单场最长时长（秒） */
	longestDurationSeconds: number;
	/** 连续直播天数（截止到最近一次直播） */
	streakDays: number;
	/** 各平台的天数分布 */
	platformDays: Record<LivePlatformId, number>;
};

/** 月历数据 */
export type LiveCalendarMonth = {
	/** YYYY-MM */
	month: string;
	/** 当月天数 */
	daysInMonth: number;
	/** 月历表格用的单元格（含上下月补齐） */
	cells: LiveCalendarCell[];
	/** 月度统计 */
	stats: LiveMonthStats;
};

/** 粉丝增减柱状图的一个数据点 */
export type FollowerDeltaPoint = {
	/** 日期 YYYY-MM-DD */
	date: string;
	/** 当天粉丝总数 */
	total: number;
	/** 相比上一个快照的增减值；没有前一个快照时为 null */
	delta: number | null;
	/** 是否为区间内第一个点（没有可比对象） */
	isBaseline: boolean;
};

/** 某平台某月的粉丝图表数据 */
export type FollowerChartSeries = {
	platform: LivePlatformId;
	/** 账号昵称 */
	name?: string;
	/** 最新粉丝总数 */
	total: number;
	/** 区间内粉丝净增减 */
	netChange: number;
	/** 图表数据点 */
	points: FollowerDeltaPoint[];
	/** 区间内最大增幅，用于坐标轴 */
	maxDelta: number;
	/** 区间内最大降幅（正数），用于坐标轴 */
	minDelta: number;
};

/** 月份选项 */
export type LiveMonthOption = {
	/** YYYY-MM */
	key: string;
	/** 展示用文案，如 2026年2月 */
	label: string;
	/** 该月是否存在数据 */
	hasData: boolean;
};
