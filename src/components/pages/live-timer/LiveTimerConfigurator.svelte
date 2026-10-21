<script lang="ts">
/**
 * 直播加时 · 配置台
 *
 * 这个页面只做三件事：
 *   1. 把叠层的样式参数（位置/缩放/文案/配色）即时预览出来；
 *   2. 生成可直接粘进 OBS 浏览器源的地址；
 *   3. 生成服务端能直接用的配置片段（礼物 → 分钟、上限）。
 *
 * 页面是纯静态的，不会写服务器上的文件 —— 配置生成后由你自己覆盖到
 * /etc/live-timer/config.json，再 systemctl restart live-timer。
 */
import { onMount } from "svelte";

interface GiftRow {
	id: number;
	name: string;
	minutes: number;
}

const BASE = import.meta.env.BASE_URL;
const OVERLAY_PATH = `${BASE}live-timer/`;
const DEFAULT_LABEL = "距下播还有";

const POSITIONS: { value: string; name: string }[] = [
	{ value: "tl", name: "左上" },
	{ value: "tc", name: "中上" },
	{ value: "tr", name: "右上" },
	{ value: "bl", name: "左下" },
	{ value: "bc", name: "中下" },
	{ value: "br", name: "右下" },
];

let roomId = $state("1750753391");
let initialMinutes = $state(120);
let cnyToMinutes = $state(1);
let ignoreSilver = $state(true);

let rowSeq = 3;
let giftRows = $state<GiftRow[]>([
	{ id: 1, name: "小心心", minutes: 0 },
	{ id: 2, name: "小花花", minutes: 2 },
	{ id: 3, name: "辣条", minutes: 0 },
]);

let guardCaptain = $state(30);
let guardAdmiral = $state(60);
let guardGovernor = $state(120);

let perGift = $state(60);
let perUser = $state(10);
let totalCap = $state(480);

let pos = $state("bl");
let scale = $state(1);
let label = $state(DEFAULT_LABEL);
let accent = $state("#FB7299");
let theme = $state("dark");
let showGifts = $state(true);
let showBar = $state(true);
let overtime = $state(true);

let origin = $state("");
let copied = $state("");
let previewUrl = $state(`${OVERLAY_PATH}?mock=1&bg=1&mockMinutes=120`);

onMount(() => {
	origin = window.location.origin;
});

/** 样式参数 → URL 查询串（默认值不写进 URL，地址保持干净） */
const styleQuery = $derived.by(() => {
	const params = new URLSearchParams();
	if (pos !== "bl") params.set("pos", pos);
	if (scale !== 1) params.set("scale", String(scale));
	if (label.trim() && label.trim() !== DEFAULT_LABEL)
		params.set("label", label.trim());
	if (accent.toLowerCase() !== "#fb7299") params.set("accent", accent);
	if (theme !== "dark") params.set("theme", theme);
	if (!showGifts) params.set("gifts", "0");
	if (!showBar) params.set("bar", "0");
	if (!overtime) params.set("overtime", "0");
	return params.toString();
});

const obsUrl = $derived(
	`${origin}${OVERLAY_PATH}${styleQuery ? `?${styleQuery}` : ""}`,
);

// 预览地址跟样式联动，但打字时别每敲一下就重载 iframe
$effect(() => {
	const params = new URLSearchParams(styleQuery);
	params.set("mock", "1");
	params.set("bg", "1");
	params.set("mockMinutes", String(initialMinutes));
	const next = `${OVERLAY_PATH}?${params.toString()}`;
	const timer = setTimeout(() => {
		previewUrl = next;
	}, 350);
	return () => clearTimeout(timer);
});

const giftMap = $derived.by(() => {
	const map: Record<string, number> = {};
	for (const row of giftRows) {
		const name = row.name.trim();
		if (!name) continue;
		map[name] = Number(row.minutes) || 0;
	}
	return map;
});

const configJson = $derived(
	JSON.stringify(
		{
			roomId: Number(roomId) || 0,
			initialMinutes: Number(initialMinutes) || 0,
			cnyToMinutes: Number(cnyToMinutes) || 0,
			ignoreSilverGifts: ignoreSilver,
			gifts: giftMap,
			guards: {
				1: Number(guardCaptain) || 0,
				2: Number(guardAdmiral) || 0,
				3: Number(guardGovernor) || 0,
			},
			caps: {
				perGiftMinutes: Number(perGift) || 0,
				perUserPerMinute: Number(perUser) || 0,
				totalMinutes: Number(totalCap) || 0,
			},
		},
		null,
		2,
	),
);

/** 100 元能换多久，给个直观参照 */
const hundredYuan = $derived(formatSpan(100 * Number(cnyToMinutes) * 60_000));

function formatSpan(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function addRow(): void {
	rowSeq += 1;
	giftRows = [...giftRows, { id: rowSeq, name: "", minutes: 1 }];
}

function removeRow(id: number): void {
	giftRows = giftRows.filter((row) => row.id !== id);
}

function fallbackCopy(text: string): boolean {
	const area = document.createElement("textarea");
	area.value = text;
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	document.body.removeChild(area);
	return ok;
}

async function copy(text: string, key: string): Promise<void> {
	let ok = false;
	try {
		await navigator.clipboard.writeText(text);
		ok = true;
	} catch {
		ok = fallbackCopy(text);
	}
	copied = ok ? key : "";
	if (ok) {
		setTimeout(() => {
			if (copied === key) copied = "";
		}, 1800);
	}
}

function downloadConfig(): void {
	const blob = new Blob([`${configJson}\n`], {
		type: "application/json;charset=utf-8",
	});
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = "live-timer-tunables.json";
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
</script>

<div class="configurator">
	<div class="panels">
		<div class="form">
			<section class="panel">
				<h3>直播与时长</h3>
				<div class="grid">
					<label>
						<span>直播间号</span>
						<input type="text" bind:value={roomId} inputmode="numeric" />
					</label>
					<label>
						<span>开局时长（分钟）</span>
						<input type="number" min="1" max="1440" bind:value={initialMinutes} />
					</label>
					<label>
						<span>1 元 = 多少分钟</span>
						<input type="number" min="0" step="0.1" bind:value={cnyToMinutes} />
					</label>
					<label class="check">
						<input type="checkbox" bind:checked={ignoreSilver} />
						<span>免费礼物（银瓜子）不加时</span>
					</label>
				</div>
				<p class="hint">
					按当前设置，100 元 ≈ <strong>{hundredYuan}</strong>。没命中下面礼物表的礼物一律按这个比例算。
				</p>
			</section>

			<section class="panel">
				<h3>礼物表</h3>
				<p class="hint">名字要和弹幕里推的 <code>giftName</code> 一字不差；填 <strong>0</strong> 表示这个礼物不加时。</p>
				<div class="rows">
					{#each giftRows as row (row.id)}
						<div class="row">
							<input type="text" placeholder="礼物名，如 小花花" bind:value={row.name} />
							<input class="minutes" type="number" min="0" step="0.5" bind:value={row.minutes} />
							<span class="unit">分钟</span>
							<button
								type="button"
								class="ghost danger"
								title="删掉这一行"
								onclick={() => removeRow(row.id)}
								disabled={giftRows.length <= 1}
							>
								×
							</button>
						</div>
					{/each}
				</div>
				<button type="button" class="ghost" onclick={addRow}>+ 加一行</button>
			</section>

			<section class="panel">
				<h3>大航海</h3>
				<div class="grid three">
					<label>
						<span>舰长</span>
						<input type="number" min="0" bind:value={guardCaptain} />
					</label>
					<label>
						<span>提督</span>
						<input type="number" min="0" bind:value={guardAdmiral} />
					</label>
					<label>
						<span>总督</span>
						<input type="number" min="0" bind:value={guardGovernor} />
					</label>
				</div>
			</section>

			<section class="panel">
				<h3>上限保护</h3>
				<div class="grid three">
					<label>
						<span>单次礼物</span>
						<input type="number" min="0" bind:value={perGift} />
					</label>
					<label>
						<span>单人/分钟</span>
						<input type="number" min="0" bind:value={perUser} />
					</label>
					<label>
						<span>整场总量</span>
						<input type="number" min="0" bind:value={totalCap} />
					</label>
				</div>
				<p class="hint">单位都是分钟；填 0 表示不限制。整场总量建议一定要设，不然一场能被加到天亮。</p>
			</section>

			<section class="panel">
				<h3>叠层样式</h3>
				<div class="field">
					<span class="field-name">停靠位置</span>
					<div class="segmented">
						{#each POSITIONS as item (item.value)}
							<button
								type="button"
								class:active={pos === item.value}
								onclick={() => (pos = item.value)}
							>
								{item.name}
							</button>
						{/each}
					</div>
				</div>

				<div class="field">
					<span class="field-name">缩放 <em>{scale.toFixed(2)}×</em></span>
					<input type="range" min="0.6" max="2" step="0.05" bind:value={scale} />
				</div>

				<div class="grid">
					<label>
						<span>顶部文案</span>
						<input type="text" bind:value={label} maxlength="20" />
					</label>
					<label>
						<span>主色</span>
						<input type="color" bind:value={accent} />
					</label>
				</div>

				<div class="toggles">
					<label class="check"><input type="checkbox" bind:checked={showGifts} /><span>礼物飘屏</span></label>
					<label class="check"><input type="checkbox" bind:checked={showBar} /><span>进度条与明细</span></label>
					<label class="check"><input type="checkbox" bind:checked={overtime} /><span>超时显示加班</span></label>
					<label class="check">
						<input
							type="checkbox"
							checked={theme === "light"}
							onchange={(event) => (theme = event.currentTarget.checked ? "light" : "dark")}
						/>
						<span>浅色主题</span>
					</label>
				</div>
			</section>
		</div>

		<aside class="side">
			<section class="panel sticky">
				<h3>预览</h3>
				<div class="preview">
					<iframe title="叠层预览" src={previewUrl} sandbox="allow-scripts allow-same-origin"></iframe>
				</div>
				<p class="hint">预览用的是本地假数据（每秒走字、每 6 秒飘一条假礼物），不影响线上。</p>

				<h3 class="gap">OBS 地址</h3>
				<div class="output">
					<textarea readonly rows="2">{obsUrl}</textarea>
					<div class="output-actions">
						<button type="button" class="primary" onclick={() => copy(obsUrl, "obs")}>
							{copied === "obs" ? "已复制" : "复制地址"}
						</button>
						<a class="ghost" href={obsUrl} target="_blank" rel="noreferrer noopener">新窗口打开</a>
					</div>
				</div>
				<p class="hint">OBS → 来源 → 浏览器源，宽高填 1920×1080，页面背景本身就是透明的。</p>

				<h3 class="gap">服务端配置片段</h3>
				<div class="output">
					<textarea readonly rows="12">{configJson}</textarea>
					<div class="output-actions">
						<button type="button" class="primary" onclick={() => copy(configJson, "json")}>
							{copied === "json" ? "已复制" : "复制配置"}
						</button>
						<button type="button" class="ghost" onclick={downloadConfig}>下载</button>
					</div>
				</div>
				<p class="hint warn">
					这是<strong>片段</strong>：把这几项合并进 <code>/etc/live-timer/config.json</code>，
					别整份覆盖 —— 里面的 <code>outFile</code>、<code>stateFile</code>、<code>adminToken</code> 要保留服务器上的原值。
					改完 <code>sudo systemctl restart live-timer</code>。
				</p>
			</section>
		</aside>
	</div>
</div>

<style>
	.configurator {
		width: 100%;
	}

	.panels {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}

	@media (max-width: 1100px) {
		.panels {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}

	.panel {
		padding: 1rem 1.1rem 1.15rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.9rem;
		background-color: var(--card-bg);
		min-width: 0;
	}

	.side .sticky {
		position: sticky;
		top: 1rem;
	}

	h3 {
		margin: 0 0 0.75rem;
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--deep-text);
	}

	h3.gap {
		margin-top: 1.15rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.7rem 0.9rem;
	}

	.grid.three {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--content-meta);
		min-width: 0;
	}

	label > span {
		font-weight: 600;
	}

	input[type="text"],
	input[type="number"] {
		width: 100%;
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font: inherit;
		font-size: 0.85rem;
		box-sizing: border-box;
	}

	input[type="number"] {
		font-variant-numeric: tabular-nums;
	}

	input[type="color"] {
		width: 100%;
		height: 2.1rem;
		padding: 0.15rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.55rem;
		background-color: var(--btn-regular-bg);
		cursor: pointer;
	}

	input[type="range"] {
		width: 100%;
		accent-color: var(--primary);
	}

	input:focus-visible,
	button:focus-visible,
	textarea:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.82rem;
		color: var(--deep-text);
		cursor: pointer;
	}

	.check input {
		accent-color: var(--primary);
		width: 1rem;
		height: 1rem;
		cursor: pointer;
	}

	.field {
		margin-bottom: 0.85rem;
	}

	.field-name {
		display: block;
		margin-bottom: 0.35rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--content-meta);
	}

	.field-name em {
		font-style: normal;
		color: var(--primary);
		font-variant-numeric: tabular-nums;
	}

	.segmented {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.35rem;
	}

	.segmented button {
		padding: 0.35rem 0;
		border: 1px solid var(--line-divider);
		border-radius: 0.5rem;
		background-color: var(--btn-regular-bg);
		color: var(--content-meta);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
		transition:
			color 0.15s,
			border-color 0.15s,
			background-color 0.15s;
	}

	.segmented button:hover {
		color: var(--primary);
	}

	.segmented button.active {
		border-color: var(--primary);
		color: var(--primary);
		background-color: var(--btn-plain-bg-hover);
		font-weight: 700;
	}

	.toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1.2rem;
		margin-top: 0.4rem;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin-bottom: 0.6rem;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 5.5rem auto auto;
		align-items: center;
		gap: 0.45rem;
	}

	.row input {
		min-width: 0;
	}

	.unit {
		font-size: 0.72rem;
		color: var(--content-meta);
	}

	button {
		font: inherit;
		cursor: pointer;
	}

	.ghost {
		padding: 0.35rem 0.7rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.5rem;
		background-color: transparent;
		color: var(--content-meta);
		font-size: 0.78rem;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.ghost:hover:not(:disabled) {
		color: var(--primary);
		border-color: var(--primary);
	}

	.ghost:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ghost.danger {
		padding: 0.35rem 0.55rem;
		line-height: 1;
	}

	.ghost.danger:hover {
		color: #f43f5e;
		border-color: #f43f5e;
	}

	.primary {
		padding: 0.35rem 0.9rem;
		border: 1px solid var(--primary);
		border-radius: 0.5rem;
		background-color: var(--primary);
		color: #fff;
		font-size: 0.78rem;
		font-weight: 600;
		transition: opacity 0.15s;
	}

	.primary:hover {
		opacity: 0.88;
	}

	.preview {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 0.75rem;
		overflow: hidden;
		background:
			radial-gradient(circle at 20% 20%, #1e2233 0%, #0b0d14 60%, #05060a 100%);
	}

	.preview iframe {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
	}

	.output textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--line-divider);
		border-radius: 0.6rem;
		background-color: var(--btn-regular-bg);
		color: var(--deep-text);
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-size: 0.74rem;
		line-height: 1.55;
		resize: vertical;
	}

	.output-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.hint {
		margin: 0.6rem 0 0;
		font-size: 0.74rem;
		line-height: 1.65;
		color: var(--content-meta);
	}

	.hint code {
		padding: 0.05rem 0.3rem;
		border-radius: 0.3rem;
		background-color: var(--btn-regular-bg);
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.72rem;
	}

	.hint strong {
		color: var(--deep-text);
	}

	.hint.warn {
		padding: 0.55rem 0.7rem;
		border-left: 3px solid var(--primary);
		border-radius: 0.4rem;
		background-color: var(--btn-plain-bg-hover);
	}
</style>
