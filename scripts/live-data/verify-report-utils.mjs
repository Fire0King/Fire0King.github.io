#!/usr/bin/env node
/**
 * 直播数据页面逻辑自检（不需要启动 Astro）
 *
 *   npx tsx scripts/live-data/verify-report-utils.mjs
 *   （或在仓库根目录：node --import tsx scripts/live-data/verify-report-utils.mjs）
 *
 * 直接跑 TypeScript 工具层，验证月历、统计与粉丝增减的计算结果，
 * 方便在没有完整构建环境时确认页面数据逻辑是否正确。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildCalendarMonth,
	buildFollowerSeries,
	buildMonthOptions,
	computeStreak,
	formatDuration,
	getTodayKey,
	shiftDateKey,
	summarizeDay,
	toClock,
	toDateKey,
} from "../../src/utils/live-report-utils.ts";

const ROOT_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const streams = JSON.parse(
	readFileSync(path.join(ROOT_DIR, "src/data/live/streams.json"), "utf8"),
);
const followers = JSON.parse(
	readFileSync(path.join(ROOT_DIR, "src/data/live/followers.json"), "utf8"),
);

const timezone = streams.timezone || "Asia/Shanghai";
const todayKey = getTodayKey(timezone);
const months = buildMonthOptions(
	streams.records.map((record) => record.date),
	todayKey,
	"zh-CN",
);
const month = months[0].key;
const calendar = buildCalendarMonth(month, streams.records, {
	weekStart: "monday",
	todayKey,
	platform: "all",
	timezone,
	activeStreams: Object.values(streams.active ?? {}),
});
const series = buildFollowerSeries("bilibili", followers, month);

/** 是否已经有采集数据：没有数据时只验证纯函数，依赖数据的断言会被跳过 */
const hasData =
	(streams.records?.length ?? 0) > 0 ||
	Object.values(followers.series ?? {}).some(
		(platformSeries) => (platformSeries?.points?.length ?? 0) > 0,
	);

const checks = [
	["今天日期键格式", /^\d{4}-\d{2}-\d{2}$/.test(todayKey)],
	["月历单元格数是 7 的倍数", calendar.cells.length % 7 === 0],
	[
		"月历覆盖当月每一天",
		calendar.cells.filter((cell) => cell.inMonth).length ===
			calendar.daysInMonth,
	],
];

if (hasData) {
	checks.push(
		["直播天数 > 0", calendar.stats.liveDays > 0],
		["总时长 > 0", calendar.stats.totalDurationSeconds > 0],
		[
			"平均时长 = 总时长 / 场次",
			calendar.stats.streamCount > 0 &&
				Math.abs(
					calendar.stats.averageDurationSeconds -
						calendar.stats.totalDurationSeconds / calendar.stats.streamCount,
				) <= 1,
		],
		[
			"最长一场 >= 平均时长",
			calendar.stats.longestDurationSeconds >=
				calendar.stats.averageDurationSeconds,
		],
		["连续直播天数 >= 1", calendar.stats.streakDays >= 1],
		["粉丝序列有数据点", series.points.length > 0],
		[
			"净增减 = 各数据点增减之和",
			series.netChange ===
				series.points.reduce((sum, point) => sum + (point.delta ?? 0), 0),
		],
	);
}

checks.push(
	["跨月日期键正确", shiftDateKey("2026-03-01", -1) === "2026-02-28"],
	["闰年日期键正确", shiftDateKey("2024-02-28", 1) === "2024-02-29"],
	["时长格式化", formatDuration(3720, "小时", "分钟") === "1小时2分钟"],
	[
		"时刻格式化（按配置时区）",
		toClock("2026-06-19T19:30:00+08:00", timezone) === "19:30",
	],
	[
		"日期键换算（按配置时区）",
		toDateKey("2026-06-19T23:30:00+08:00", timezone) === "2026-06-19",
	],
	[
		"连续天数：断档后从最近一次算起",
		computeStreak(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05"]) ===
			1,
	],
	[
		"连续天数：连续三天",
		computeStreak(["2026-01-05", "2026-01-04", "2026-01-03"]) === 3,
	],
);

// 直播中标记只应出现在"当前场次开播的那一天"，而不是该平台的所有历史日期
const sampleRecord = {
	id: "sample",
	platform: "bilibili",
	title: "样例",
	date: "2026-01-05",
	start: "2026-01-05T20:00:00+08:00",
	end: "2026-01-05T22:00:00+08:00",
	durationSeconds: 7200,
};
const sampleActive = new Map([["bilibili", "2026-01-05"]]);
checks.push(
	[
		"直播中标记：当天为真",
		summarizeDay("2026-01-05", [sampleRecord], sampleActive).hasActive === true,
	],
	[
		"直播中标记：同平台其他日期为假",
		summarizeDay("2026-01-06", [sampleRecord], sampleActive).hasActive ===
			false,
	],
	[
		"直播中标记：无在播场次时为假",
		summarizeDay("2026-01-05", [sampleRecord], new Map()).hasActive === false,
	],
);

let failed = 0;
for (const [name, ok] of checks) {
	if (!ok) failed += 1;
	console.log(`${ok ? "✅" : "❌"} ${name}`);
}

console.log("");
if (!hasData) {
	console.log(
		"⚠️ src/data/live 里还没有采集数据，已跳过依赖数据的断言（等 Actions 跑过一次再执行会更完整）",
	);
}
console.log(
	`月份 ${month} | 直播天数 ${calendar.stats.liveDays} | 场次 ${calendar.stats.streamCount} | 连续 ${calendar.stats.streakDays} 天`,
);
console.log(
	`总时长 ${formatDuration(calendar.stats.totalDurationSeconds, "小时", "分钟")} | 粉丝 ${series.total} | 区间净增 ${series.netChange} | 数据点 ${series.points.length}`,
);
process.exit(failed === 0 ? 0 : 1);
