import type { SiteConfig } from "@/types/siteConfig";

// 站点语言的环境变量覆盖工具
// 把「读取 PUBLIC_SITE_LANG 环境变量并规整为合法语言」的逻辑收敛在这里，
// 让 siteConfig.ts 保持纯配置，不掺杂判断代码

// 读取站点语言环境变量（Vite/Astro 走 import.meta.env，构建脚本回退 process.env）
function readSiteLangEnv(): string | undefined {
	try {
		const raw = (import.meta.env as Record<string, unknown>).PUBLIC_SITE_LANG;
		return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
	} catch {
		return typeof process === "undefined"
			? undefined
			: process.env.PUBLIC_SITE_LANG;
	}
}

// 规整成 SiteConfig.lang 的合法取值，无法识别时返回 undefined（回退到默认值）
function normalizeSiteLang(
	value: string | undefined,
): SiteConfig["lang"] | undefined {
	if (!value) return undefined;
	const v = value.toLowerCase();
	if (v === "zh_cn" || v === "zh-cn") return "zh_CN";
	if (v === "zh_tw" || v === "zh-tw") return "zh_TW";
	if (v === "ja" || v === "ja_jp" || v === "ja-jp") return "ja";
	if (v === "ru" || v === "ru_ru" || v === "ru-ru") return "ru";
	if (v === "ko" || v === "ko_kr" || v === "ko-kr") return "ko";
	if (
		v === "en" ||
		v === "en_us" ||
		v === "en_gb" ||
		v === "en-us" ||
		v === "en-gb"
	) {
		return "en";
	}
	return undefined;
}

// 站点语言，环境变量 PUBLIC_SITE_LANG 优先，未设置或无法识别时使用默认值
// 例如在部署平台设置 PUBLIC_SITE_LANG=en 即可让站点以英文构建，无需修改配置文件
export function resolveSiteLang(
	defaultLang: SiteConfig["lang"],
): SiteConfig["lang"] {
	return normalizeSiteLang(readSiteLangEnv()) ?? defaultLang;
}

// 读取字符串型环境变量
// 注意：Astro 加载 astro.config.mjs 的阶段，Vite 还没把 PUBLIC_* 注入 import.meta.env，
// 因此 import.meta.env 取不到时必须回退到 process.env，否则部署平台设置的变量不会生效。
// 浏览器端则相反：import.meta.env 已被静态替换，process 不存在，所以用 typeof 保护。
function readPublicEnv(key: string): string | undefined {
	try {
		const raw = (import.meta.env as Record<string, unknown>)[key];
		if (typeof raw === "string" && raw.trim()) return raw.trim();
	} catch {
		// 非 Vite 环境（例如直接跑构建脚本）没有 import.meta.env
	}
	if (typeof process === "undefined") return undefined;
	const value = process.env[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// 站点 URL（origin，不含子路径），优先 PUBLIC_SITE_URL，其次 Cloudflare Pages 注入的 CF_PAGES_URL
// 例：GitHub Pages 上设为 https://<用户名>.github.io，子路径由 PUBLIC_BASE_PATH 处理；
//     Cloudflare Pages 上不设也行，构建时会自动用当前部署的 https://<项目>.pages.dev
export function resolveSiteUrl(defaultUrl: string): string {
	const explicit = readPublicEnv("PUBLIC_SITE_URL");
	if (explicit) return explicit.replace(/\/+$/, "");
	// Cloudflare Pages 构建环境自带 CF_PAGES_URL，省掉手动配一遍
	const pagesUrl = readPublicEnv("CF_PAGES_URL");
	if (pagesUrl) return pagesUrl.replace(/\/+$/, "");
	return defaultUrl;
}

// 站点子路径 base，环境变量 PUBLIC_BASE_PATH 优先，默认根路径 "/"
// 例：GitHub Pages 的 project page（https://user.github.io/repo/）需要设置为 /repo
// Astro 会据此生成 import.meta.env.BASE_URL，主题内所有链接/资源都走 url() 适配
export function resolveBasePath(defaultBase = "/"): string {
	const value = readPublicEnv("PUBLIC_BASE_PATH") ?? defaultBase;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "/") return "/";
	// 去掉首尾多余的斜杠，Astro 期望形如 "/repo"
	return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

// 由语言代码生成 OpenGraph og:locale（language_TERRITORY 格式）。
// 站点语言已是下划线形式（zh_CN/zh_TW/en/ja/ko/ru），仅需为无地区的语言补全区号。
export function getOgLocale(lang: string): string {
	switch (lang.toLowerCase().replace("-", "_")) {
		case "zh_cn":
			return "zh_CN";
		case "zh_tw":
			return "zh_TW";
		case "ja":
			return "ja_JP";
		case "ko":
			return "ko_KR";
		case "ru":
			return "ru_RU";
		default:
			return "en_US";
	}
}
