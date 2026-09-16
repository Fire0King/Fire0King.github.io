// 站点 URL 解析优先级自检：PUBLIC_SITE_URL > CF_PAGES_URL（Cloudflare Pages）> 默认值
// 运行：npx tsx scripts/verify-site-url.mjs
const { resolveSiteUrl } = await import("../src/utils/site-config-utils.ts");

const fallback = "https://fire0king.github.io";
const cases = [
	{ name: "都没设 → 用默认值", env: {}, expect: fallback },
	{
		name: "只有 CF_PAGES_URL（Cloudflare Pages 构建）",
		env: { CF_PAGES_URL: "https://fire0king-blog.pages.dev" },
		expect: "https://fire0king-blog.pages.dev",
	},
	{
		name: "绑了自定义域名（显式优先）",
		env: {
			CF_PAGES_URL: "https://fire0king-blog.pages.dev",
			PUBLIC_SITE_URL: "https://blog.twoleaf.cn/",
		},
		expect: "https://blog.twoleaf.cn",
	},
	{
		name: "GitHub Pages（现有部署方式）",
		env: { PUBLIC_SITE_URL: "https://fire0king.github.io" },
		expect: "https://fire0king.github.io",
	},
];

let failed = 0;
for (const item of cases) {
	for (const key of ["PUBLIC_SITE_URL", "CF_PAGES_URL"]) {
		delete process.env[key];
	}
	Object.assign(process.env, item.env);
	const actual = resolveSiteUrl(fallback);
	const ok = actual === item.expect;
	if (!ok) failed += 1;
	console.log(`${ok ? "✅" : "❌"} ${item.name}：${actual}`);
}
process.exit(failed === 0 ? 0 : 1);
