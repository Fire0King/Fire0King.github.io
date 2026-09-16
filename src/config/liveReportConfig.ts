import type {
	LivePlatformId,
	LiveReportConfig,
} from "../types/liveReportConfig";
import rawConfig from "./live-report.config.json";

// ============================================================================
// 直播数据页面配置
// 真正的配置值写在 src/config/live-report.config.json —— 那里是站点页面与抓取脚本
// (scripts/live-data/collect.mjs) 共用的唯一配置源。这里只做默认值兜底和类型收窄。
//
// 需要填的字段：
//   bilibili.uid    —— 你的 B站 UID（个人空间网址里那串数字）
//   bilibili.roomId —— 直播间号（可选，填了时长能精确到秒）
//   douyin.secUid   —— 抖音主页 sec_uid（主页链接 /user/ 后面那段 MS4wLjABAAAA...）
//   douyin.webRid   —— 直播间号 live.douyin.com/{webRid}
// 没有身份凭据的公开接口也能取数，但抖音风控较严，建议额外配置仓库 Secrets：
//   BILIBILI_COOKIE / DOUYIN_COOKIE（只有抓取脚本用得到，不会进入站点产物）
// ============================================================================

const raw = rawConfig as unknown as LiveReportConfig;

/** 空字符串一律归一化为 undefined，避免下游到处判断 */
function clean(value: string | undefined): string | undefined {
	const trimmed = (value ?? "").trim();
	return trimmed === "" ? undefined : trimmed;
}

/** 直播数据页面配置（已填充默认值） */
export const liveReportConfig: LiveReportConfig = {
	// 留空则使用 i18n 里的默认标题/副标题（推荐留空，便于多语言站点）
	title: clean(raw.title),
	subtitle: clean(raw.subtitle),
	timezone: raw.timezone || "Asia/Shanghai",
	weekStart: raw.weekStart === "sunday" ? "sunday" : "monday",
	bilibili: {
		enable: raw.bilibili?.enable !== false,
		uid: clean(raw.bilibili?.uid) ?? "",
		roomId: clean(raw.bilibili?.roomId),
	},
	douyin: {
		enable: raw.douyin?.enable !== false,
		secUid: clean(raw.douyin?.secUid),
		webRid: clean(raw.douyin?.webRid),
		roomId: clean(raw.douyin?.roomId),
	},
	collector: {
		intervalMinutes: Number(raw.collector?.intervalMinutes) || 10,
		followerSnapshotIntervalHours:
			Number(raw.collector?.followerSnapshotIntervalHours) || 12,
		titleUpdateIntervalMinutes:
			Number(raw.collector?.titleUpdateIntervalMinutes) || 30,
		retentionDays: Number(raw.collector?.retentionDays) || 0,
	},
	manualRecords: Array.isArray(raw.manualRecords) ? raw.manualRecords : [],
};

/** 已启用且填了账号标识的平台列表 */
export const enabledLivePlatforms: LivePlatformId[] = (
	[
		liveReportConfig.bilibili.enable && liveReportConfig.bilibili.uid
			? "bilibili"
			: null,
		liveReportConfig.douyin.enable && liveReportConfig.douyin.secUid
			? "douyin"
			: null,
	] as (LivePlatformId | null)[]
).filter((platform): platform is LivePlatformId => platform !== null);

/** 是否至少配置了一个平台，未配置时页面会给出提示而不是展示空图表 */
export const isLiveReportConfigured: boolean = enabledLivePlatforms.length > 0;
