<script lang="ts">
/**
 * 直播数据页面专用图标
 * 刻意使用内联路径而不是公共 Icon 组件：公共 Icon 依赖离线图标数据
 * (src/constants/icons-data.json)，新增图标需要重新生成数据，这里保持自包含。
 */

type LiveIconName =
	| "calendar"
	| "clock"
	| "chart"
	| "trophy"
	| "star"
	| "broadcast"
	| "users"
	| "chevronLeft"
	| "chevronRight"
	| "arrowUp"
	| "arrowDown"
	| "external";

interface Props {
	name: LiveIconName;
	/**
	 * 尺寸/颜色类。
	 * 注意：组件的根元素收不到父组件的 Svelte 作用域样式（父组件里写 .foo { width: … }
	 * 这类规则会因为没有元素匹配而被裁掉，图标就会按浏览器默认尺寸撑开），
	 * 所以尺寸请一律用 Tailwind 工具类（h-4 / w-4 等）或下面 svg 上的 1em 默认值。
	 */
	class?: string;
}

let { name, class: className = "" }: Props = $props();

const PATHS: Record<LiveIconName, string> = {
	calendar:
		"M5 5.5h14A1.5 1.5 0 0 1 20.5 7v11A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V7A1.5 1.5 0 0 1 5 5.5Z M3.5 10h17 M8 3.5v4 M16 3.5v4",
	clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7.5V12l3.2 1.9",
	chart: "M5 20v-9 M12 20V4 M19 20v-6 M3.5 20h17",
	trophy:
		"M8 4h8v5.2a4 4 0 0 1-8 0V4Z M8 6H5.5v1.6a3 3 0 0 0 3 3 M16 6h2.5v1.6a3 3 0 0 1-3 3 M12 13.2V17 M8.5 20h7",
	star: "M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8Z",
	broadcast:
		"M12 13.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z M7.6 7.6a6.2 6.2 0 0 0 0 8.8 M16.4 7.6a6.2 6.2 0 0 1 0 8.8 M4.6 4.6a10.5 10.5 0 0 0 0 14.8 M19.4 4.6a10.5 10.5 0 0 1 0 14.8",
	users:
		"M9 11.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z M2.6 20a6.4 6.4 0 0 1 12.8 0 M16.4 5a3.6 3.6 0 0 1 0 6.9 M18.2 20a6.4 6.4 0 0 0-1.8-4.5",
	chevronLeft: "M14.5 5.5l-6.5 6.5 6.5 6.5",
	chevronRight: "M9.5 5.5l6.5 6.5-6.5 6.5",
	arrowUp: "M12 19.5V4.5 M5.8 10.7 12 4.5l6.2 6.2",
	arrowDown: "M12 4.5v15 M5.8 13.3 12 19.5l6.2-6.2",
	external:
		"M14 4.5h5.5V10 M18.8 5.2 11 13 M17.8 14.4V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.6",
};
</script>

<svg
	class={className}
	width="1em"
	height="1em"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.7"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d={PATHS[name]} />
</svg>
