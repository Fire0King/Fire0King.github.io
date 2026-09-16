// 直播报表配置类型
// 对应 src/config/live-report.config.json —— 站点页面与 GitHub Actions 抓取脚本共用同一份配置

/** 支持的直播平台 */
export type LivePlatformId = "bilibili" | "douyin";

/** B站账号配置 */
export type LiveReportBilibiliConfig = {
	/** 是否采集/展示 B站 数据 */
	enable: boolean;
	/** B站 用户 UID（个人空间地址里那串数字） */
	uid: string;
	/** 直播间号（可选）。填了可以用 live_time 拿到精确到秒的开播时间，时长更准 */
	roomId?: string;
};

/** 抖音账号配置 */
export type LiveReportDouyinConfig = {
	/** 是否采集/展示 抖音 数据 */
	enable: boolean;
	/** 抖音主页 sec_uid，形如 MS4wLjABAAAA...（主页链接 /user/ 后面那段） */
	secUid?: string;
	/** 直播间 web_rid，即 live.douyin.com/{web_rid} 里的那串数字 */
	webRid?: string;
	/** 直播间 room_id（用户主页响应 room_data 里的 room_id_str），部分接口需要 */
	roomId?: string;
};

/** 抓取相关配置，主要给 scripts/live-data/collect.mjs 使用 */
export type LiveReportCollectorConfig = {
	/** 轮询间隔（分钟），必须与 .github/workflows/live-data.yml 里的 cron 保持一致 */
	intervalMinutes: number;
	/** 粉丝数快照的最小写入间隔（小时），避免每个轮询都产生一次提交 */
	followerSnapshotIntervalHours: number;
	/**
	 * 直播标题变化的最小写入间隔（分钟）。
	 * 有些主播会频繁改标题，节流后既能减少无意义的提交，也能避免触发
	 * GitHub Pages / Cloudflare Pages 的部署频率限制。0 表示不节流。
	 */
	titleUpdateIntervalMinutes: number;
	/** 历史数据保留天数，0 表示不限制 */
	retentionDays: number;
};

/** 手动补录的直播记录，用于补上开播机器人上线之前的历史场次 */
export type LiveReportManualRecord = {
	/** JSON 里不能写注释，用这个字段写备注（不参与逻辑） */
	_note?: string;
	/** 平台 */
	platform: LivePlatformId;
	/** 当时的直播标题 */
	title: string;
	/** 开始时间，ISO 字符串，建议带时区偏移，如 2026-02-14T20:00:00+08:00 */
	start: string;
	/** 结束时间，ISO 字符串 */
	end: string;
	/** 当日归属日期 YYYY-MM-DD，留空则按配置时区从 start 推导 */
	date?: string;
	/** 回放/录播地址，可选 */
	url?: string;
};

/** 直播报表配置 */
export type LiveReportConfig = {
	/** JSON 里不能写注释，用这个字段写说明（不参与逻辑） */
	_readme?: string;
	/** 页面标题 */
	title?: string;
	/** 页面副标题/描述 */
	subtitle?: string;
	/** 统计与展示使用的时区（IANA） */
	timezone: string;
	/** 一周起始日，影响月历排列 */
	weekStart: "monday" | "sunday";
	/** B站配置 */
	bilibili: LiveReportBilibiliConfig;
	/** 抖音配置 */
	douyin: LiveReportDouyinConfig;
	/** 抓取配置 */
	collector: LiveReportCollectorConfig;
	/** 手动补录的历史直播记录 */
	manualRecords: LiveReportManualRecord[];
};
