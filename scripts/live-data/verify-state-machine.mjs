#!/usr/bin/env node
/**
 * 直播数据状态机自检（不需要网络，不会写任何数据文件）
 *
 *   node scripts/live-data/verify-state-machine.mjs
 *
 * 覆盖最容易出错、代价也最大的几件事：
 *   · 开播 / 下播 / 时长结算
 *   · 接口失败时绝不能把正在直播的场次结算掉
 *   · 标题更新节流（避免频繁提交触发部署频率限制）
 *   · 粉丝快照的写入节流
 *   · 历史数据保留天数
 */

import {
	applyRetention,
	emptyFollowers,
	emptyStreams,
	isoInTimeZone,
	reconcile,
	updateFollowers,
} from "./collect.mjs";

const TIMEZONE = "Asia/Shanghai";
const config = {
	timezone: TIMEZONE,
	collector: {
		intervalMinutes: 10,
		followerSnapshotIntervalHours: 12,
		titleUpdateIntervalMinutes: 30,
		retentionDays: 0,
	},
};

const checks = [];
function check(name, ok, detail = "") {
	checks.push([name, ok, detail]);
}

function baseStreams() {
	return emptyStreams(config);
}

// ── 1. 开播：记录精确开播时间与标题 ────────────────────────────────────────
{
	const now = new Date("2026-05-01T12:00:00Z"); // 北京时间 20:00
	const startedAt = new Date("2026-05-01T11:30:00Z"); // live_time 精确到 19:30
	const result = reconcile({
		streams: baseStreams(),
		snapshots: [
			{
				platform: "bilibili",
				ok: true,
				live: true,
				title: "【歌回】点歌台",
				startedAt,
				url: "https://live.bilibili.com/1",
				roomId: 1,
			},
		],
		config,
		now,
	});
	check("开播：写入 active", Boolean(result.active.bilibili));
	check("开播：无历史记录写入", result.newRecords.length === 0);
	check(
		"开播：使用 live_time 作为开播时间",
		result.active.bilibili?.start === isoInTimeZone(startedAt, TIMEZONE),
		result.active.bilibili?.start,
	);
	check("开播：标题被记录", result.active.bilibili?.title === "【歌回】点歌台");
	check("开播：标记为有变化", result.changed === true);
}

// ── 2. 标题节流：间隔内不写，超过间隔才写 ─────────────────────────────────
{
	const streams = baseStreams();
	streams.active.bilibili = {
		platform: "bilibili",
		title: "旧标题",
		start: "2026-05-01T19:30:00+08:00",
		titleUpdatedAt: "2026-05-01T19:30:00+08:00",
	};
	const throttled = reconcile({
		streams,
		snapshots: [
			{ platform: "bilibili", ok: true, live: true, title: "新标题" },
		],
		config: {
			...config,
			collector: { ...config.collector, titleUpdateIntervalMinutes: 30 },
		},
		now: new Date("2026-05-01T19:40:00+08:00"), // 仅过 10 分钟
	});
	check(
		"标题节流：间隔内不更新",
		throttled.active.bilibili?.title === "旧标题",
	);
	check("标题节流：间隔内不算变化", throttled.changed === false);

	const allowed = reconcile({
		streams,
		snapshots: [
			{ platform: "bilibili", ok: true, live: true, title: "新标题" },
		],
		config: {
			...config,
			collector: { ...config.collector, titleUpdateIntervalMinutes: 30 },
		},
		now: new Date("2026-05-01T20:10:00+08:00"), // 过了 40 分钟
	});
	check(
		"标题节流：超过间隔即更新",
		allowed.active.bilibili?.title === "新标题",
	);
	check("标题节流：更新后算变化", allowed.changed === true);
}

// ── 3. 下播：结算时长并写入历史 ───────────────────────────────────────────
{
	const streams = baseStreams();
	streams.active.bilibili = {
		platform: "bilibili",
		title: "【杂谈】",
		start: "2026-05-01T19:30:00+08:00",
		titleUpdatedAt: "2026-05-01T19:30:00+08:00",
	};
	const result = reconcile({
		streams,
		snapshots: [{ platform: "bilibili", ok: true, live: false }],
		config,
		now: new Date("2026-05-01T22:30:00+08:00"),
	});
	check("下播：清掉 active", result.active.bilibili === undefined);
	check("下播：写入 1 条历史", result.newRecords.length === 1);
	check(
		"下播：时长结算正确（3 小时）",
		result.newRecords[0]?.durationSeconds === 10800,
		String(result.newRecords[0]?.durationSeconds),
	);
	check(
		"下播：日期归属开播当天",
		result.newRecords[0]?.date === "2026-05-01",
		result.newRecords[0]?.date,
	);
}

// ── 4. 关键：接口失败不能结算正在直播的场次 ────────────────────────────────
{
	const streams = baseStreams();
	streams.active.bilibili = {
		platform: "bilibili",
		title: "直播中",
		start: "2026-05-01T19:30:00+08:00",
	};
	const result = reconcile({
		streams,
		snapshots: [
			{ platform: "bilibili", ok: false, error: "接口失败", live: false },
			{ platform: "douyin", ok: false, error: "ck 失效", live: false },
		],
		config,
		now: new Date("2026-05-01T20:00:00+08:00"),
	});
	check("接口失败：保留 active 场次", Boolean(result.active.bilibili));
	check("接口失败：不写入任何历史", result.newRecords.length === 0);
	check("接口失败：不标记为有变化", result.changed === false);
}

// ── 5. 粉丝快照节流 ──────────────────────────────────────────────────────
{
	const followers = emptyFollowers();
	const snapshot = [
		{ platform: "bilibili", ok: true, followers: 1000, name: "测试" },
	];
	const now = new Date("2026-05-01T20:00:00+08:00");

	const first = updateFollowers({
		followers,
		snapshots: snapshot,
		config,
		now,
		force: false,
	});
	check("粉丝：首次写入", first === true);
	check("粉丝：记录当天快照", followers.series.bilibili?.points.length === 1);

	const again = updateFollowers({
		followers,
		snapshots: [{ platform: "bilibili", ok: true, followers: 1005 }],
		config,
		now: new Date("2026-05-01T21:00:00+08:00"), // 同一天，仅过 1 小时
		force: false,
	});
	check("粉丝：同一天未到间隔不写", again === false);
	check(
		"粉丝：数值未被覆盖",
		followers.series.bilibili?.points[0]?.total === 1000,
	);

	const nextDay = updateFollowers({
		followers,
		snapshots: [{ platform: "bilibili", ok: true, followers: 1010 }],
		config,
		now: new Date("2026-05-02T09:00:00+08:00"),
		force: false,
	});
	check("粉丝：第二天写入新点", nextDay === true);
	check("粉丝：累计两个数据点", followers.series.bilibili?.points.length === 2);
	check("粉丝：total 更新为最新", followers.series.bilibili?.total === 1010);

	const forced = updateFollowers({
		followers,
		snapshots: [{ platform: "bilibili", ok: true, followers: 1030 }],
		config,
		now: new Date("2026-05-02T10:00:00+08:00"),
		force: true,
	});
	check("粉丝：--force-follower 立即覆盖当天", forced === true);
	check(
		"粉丝：force 后当天数值已更新",
		followers.series.bilibili?.points.find((p) => p.date === "2026-05-02")
			?.total === 1030,
	);

	const failed = updateFollowers({
		followers: emptyFollowers(),
		snapshots: [{ platform: "douyin", ok: false, followers: 5000 }],
		config,
		now,
		force: true,
	});
	check("粉丝：失败的平台不写入", failed === false);
}

// ── 6. 历史保留天数 ──────────────────────────────────────────────────────
{
	const records = [
		{ start: "2026-04-01T20:00:00+08:00", durationSeconds: 60 },
		{ start: "2026-05-01T20:00:00+08:00", durationSeconds: 60 },
	];
	const pruned = applyRetention(
		records,
		{
			...config,
			collector: { ...config.collector, retentionDays: 30 },
		},
		new Date("2026-05-10T12:00:00+08:00"),
	);
	check(
		"保留天数：裁掉 30 天前的记录",
		pruned.length === 1 && pruned[0].start.startsWith("2026-05-01"),
		JSON.stringify(pruned.map((r) => r.start)),
	);
	const kept = applyRetention(records, config);
	check("保留天数：0 表示不裁剪", kept.length === 2);
}

// ── 输出 ─────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed += 1;
	console.log(
		`${ok ? "✅" : "❌"} ${name}${!ok && detail ? ` （实际：${detail}）` : ""}`,
	);
}
console.log(`\n共 ${checks.length} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
