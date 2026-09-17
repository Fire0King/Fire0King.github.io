import type { ProfileConfig } from "../types/profileConfig";

export const profileConfig: ProfileConfig = {
	// 头像
	// 图片路径支持三种格式：
	// 1. public 目录（以 "/" 开头，不优化）："/assets/images/avatar.webp"
	// 2. src 目录（不以 "/" 开头，自动优化但会增加构建时间，推荐）："assets/images/avatar.webp"
	// 3. 远程 URL："https://example.com/avatar.jpg"
	// avatar: "assets/images/avatar.avif",
	avatar: "https://i0.hdslb.com/bfs/face/ef22ec314bdd949928d5e04d140ccbb768c1e273.jpg",

	// 名字
	name: "千宝",

	// 个人签名
	bio: "又千世界第一可爱！",

	// 链接配置
	// 已经预装的图标集：fa7-brands，fa7-regular，fa7-solid，material-symbols，simple-icons
	// 访问https://icones.js.org/ 获取图标代码，
	// 如果想使用尚未包含相应的图标集，则需要安装它
	// `pnpm add @iconify-json/<icon-set-name>`
	// showName: true 时显示图标和名称，false 时只显示图标
	links: [
		{
			name: "Bilibili",
			icon: "fa7-brands:bilibili",
			url: "https://space.bilibili.com/525972018",
			showName: false,
		},
		{
			name: "Douyin",
			// 注意：fa7-brands / simple-icons 都没有收录 douyin 图标，写 "fa7-brands:douyin"
			// 会让构建直接失败（Unable to locate "fa7-brands:douyin" icon!）。
			// 这里用同一款音符 logo 的 tiktok 图标；想要真正的抖音 logo，
			// 把 SVG 放到 src/icons/douyin.svg，再把这里改成 "local:douyin"。
			icon: "simple-icons:tiktok",
			url: "https://www.douyin.com/user/MS4wLjABAAAAI329Ue8mubBCH-KtpQNh7T-IAg-yRZhhAl75VIJgzP4hiHdgN03sTWOUzJMHHTe1",
			showName: false,
		},
		{
			name: "RSS",
			icon: "fa7-solid:rss",
			url: "/rss/",
			showName: false,
		},
		{
			name: "Atom",
			icon: "fa7-solid:atom",
			url: "/atom/",
			showName: false,
		},
	],
};
