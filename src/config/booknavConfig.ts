import type { BooknavGroup, BooknavPageConfig } from "../types/booknavConfig";

// 书签导航页面配置
export const booknavPageConfig: BooknavPageConfig = {
	// 页面标题，如果留空则使用 i18n 中的翻译
	title: "",

	// 页面描述文本，如果留空则使用 i18n 中的翻译
	description: "",

	// favicon 自动获取配置
	favicon: {
		// 书签未填写 icon 时，是否自动获取目标站点的 favicon 图标
		enabled: true,

		// favicon 接口地址，{domain} 为占位符，会被替换成目标站点域名
		// 更换接口只需保证地址里含有 {domain}，例如：
		//   https://a.favicon.im/{domain}
		//   https://favicon.im/{domain}
		api: "https://a.favicon.im/{domain}",
	},
};

// 书签导航配置
// 每个数组项是一个分类组，分类组内的 items 是该分类下的书签
export const booknavConfig: BooknavGroup[] = [
	{
		id: "useful",
		name: "实用",
		icon: "material-symbols:code-rounded",
		desc: "电脑中实用的一些软件",
		weight: 100,
		items: [
			{
				title: "TeamSpeak",
				url: "https://www.teamspeak.com/en/downloads/",
				desc: "ts6图形化更现代，ts3系统占用更小-专业的语音通讯软件",
				// icon 字段可以使用 astro-icon 图标库的图标名称
				// 也可以使用图片 URL 和本地图片路径
				// 不填则会通过接口自动获取目标站点的 favicon 图标（需要在上面配置）
				// icon: "fa7-brands:github",
				weight: 10,
			},
			{
				title: "7-Zip",
				url: "https://7-zip.org/download.html",
				desc: "经典的解压缩软件",
				weight: 9,
			},
			{
				title: "搜狗输入法",
				url: "https://shurufa.sogou.com/",
				desc: "经典的输入法软件",
				weight: 8,
			},
			{
				title: "Steam",
				url: "https://store.steampowered.com/about/",
				desc: "进入后请确认是正版网站",
				weight: 7,
			},
			{
				title: "Watt Toolkit",
				url: "https://steampp.net/",
				desc: "Windows用户可在Microsoft store下载 - 第三方提供的免费开源Steam加速器",
				weight: 6,
			},
			{
				title: "WizTree",
				url: "https://www.diskanalyzer.com/",
				desc: "磁盘空间分析工具，推荐下载便携版（即压缩包，解压即用）",
				weight: 6,
			},
			{
				title: "Everything",
				url: "https://www.voidtools.com/zh-cn/downloads",
				desc: "文件查找工具，推荐下载便携版（即压缩包，解压即用）",
				weight: 6,
			},
			{
				title: "Bilibili直播姬",
				url: "https://link.bilibili.com/p/eden/download",
				desc: "B站官方直播工具",
				weight: 5,
			},
			{
				title: "直播伴侣",
				url: "https://streamingtool.douyin.com/",
				desc: "抖音官方直播工具",
				weight: 4,
			},
			{
				title: "OBS Studio",
				url: "https://obsproject.com/zh-cn/download",
				desc: "OBS也可以在Steam中免费下载",
				weight: 3,
			},
			{
				title: "Laplace chat",
				url: "https://chat.laplace.live/",
				desc: "第三方免费提供的 哔哩哔哩直播弹幕机-浏览器插件，用于直播间美化",
				weight: 2,
			},
			{
				title: "Radmin LAN",
				url: "https://www.radmin-lan.cn/",
				desc: "免费的虚拟局域网远程控制软件，常用于游戏联机",
				weight: 1,
			},
		],
	},
	{
		id: "opensource",
		name: "项目",
		icon: "material-symbols:code-rounded",
		desc: "好用的开源项目",
		weight: 90,
		items: [
			{
				title: "Firefly",
				url: "https://github.com/CuteLeaf/Firefly",
				desc: "清晰美观的 Astro 个人博客主题模板",
				icon: "/favicon/firefly-32.png",
				weight: 10,
			},
		],
	},
	{
		id: "design",
		name: "设计",
		icon: "material-symbols:palette-outline-rounded",
		desc: "配色、图标与灵感来源",
		weight: 90,
		items: [
			{
				title: "Iconify",
				url: "https://icon-sets.iconify.design",
				desc: "海量开源图标集合搜索",
				weight: 10,
			},
			{
				title: "iconfont",
				url: "https://www.iconfont.cn",
				desc: "阿里巴巴矢量图标库",
				weight: 9,
			},
		],
	},
	{
		id: "tools",
		name: "在线工具",
		icon: "material-symbols:build-outline-rounded",
		desc: "顺手的在线小工具",
		weight: 80,
		items: [
			{
				title: "TinyPNG",
				url: "https://tinypng.com",
				desc: "在线压缩 PNG / JPEG 图片",
				weight: 10,
			},
			{
				title: "Squoosh",
				url: "https://squoosh.app",
				desc: "Google 出品的图片压缩与格式转换",
				weight: 9,
			},
			{
				title: "Carbon",
				url: "https://carbon.now.sh",
				desc: "把代码片段生成漂亮的图片",
				weight: 8,
			},
		],
	},
];
