import { Menu } from "obsidian";
import type { Category, DateGranularity, EmailRecord, PanelConfig, PanelType } from "../types";
import {
	HERE_KEY,
	UNCAT_KEY,
	countBy,
	countByBucket,
	countByDay,
	countByWeekdayHour,
	hasOverlap,
	localIsoDate,
	seriesKeysFor,
	topSenders,
	type Series,
} from "../store/stats";
import { childrenOf, inCategory, subtreeIds } from "../classify/engine";
import { taskState } from "../classify/tasks";
import { STATUS_LABEL } from "./icons";
import {
	CATEGORY_COLORS,
	OTHER_COLOR,
	STATUS_COLORS,
	UNCATEGORIZED_COLOR,
	overlapNote,
	renderCalendar,
	renderDonut,
	renderHeatmap,
	renderRankedBars,
	renderTimeChart,
	type TimeStyle,
} from "./charts";

export interface PanelContext {
	records: EmailRecord[];
	/** Every record, unfiltered: task status must not depend on the chosen period. */
	allRecords: EmailRecord[];
	categories: Category[];
	/** null = all emails, UNCAT_KEY = uncategorized, otherwise a category id. */
	selected: string | null;
	buckets: string[];
	granularity: DateGranularity;
	bucketLabel: (key: string) => string;
	rangeStart: Date;
	onSelect: (id: string) => void;
}

interface PanelDef {
	label: string;
	styles?: [string, string][];
	render(el: HTMLElement, ctx: PanelContext, style: string | undefined): void;
}

const OTHER_KEY = "__other__";

/** How many series a chart may show before the rest fold into "Other". */
const MAX_SERIES = CATEGORY_COLORS.length;

interface SeriesInfo {
	key: string;
	label: string;
	color: string;
}

/** Series for the current selection: its child categories, itself, and Uncategorized. */
function seriesInfo(ctx: PanelContext): { infos: SeriesInfo[]; keysOf: (r: EmailRecord) => string[] } {
	const parent = ctx.selected === UNCAT_KEY ? null : ctx.selected;
	const children = ctx.selected === UNCAT_KEY ? [] : childrenOf(ctx.categories, parent);
	const shown = children.slice(0, MAX_SERIES - 1);
	const shownIds = new Set(shown.map((c) => c.id));
	const keysOf = (r: EmailRecord) => [
		...new Set(seriesKeysFor(r, ctx.selected).map((k) => (k === HERE_KEY || k === UNCAT_KEY || shownIds.has(k) ? k : OTHER_KEY))),
	];
	const here = ctx.categories.find((c) => c.id === parent);
	const infos: SeriesInfo[] = [
		...shown.map((c) => ({ key: c.id, label: c.name, color: c.color })),
		{ key: OTHER_KEY, label: "Other", color: OTHER_COLOR },
		{ key: HERE_KEY, label: `${here?.name ?? ""} (no child category)`, color: here?.color ?? OTHER_COLOR },
		{ key: UNCAT_KEY, label: "Uncategorized", color: UNCATEGORIZED_COLOR },
	];
	return { infos, keysOf };
}

function timeSeries(ctx: PanelContext): { series: Series[]; overlap: boolean } {
	const { infos, keysOf } = seriesInfo(ctx);
	const counts = countByBucket(ctx.records, ctx.buckets, ctx.granularity, keysOf);
	const series = infos
		.filter((i) => counts.get(i.key)?.some(Boolean))
		.map((i) => ({ ...i, values: counts.get(i.key)! }));
	return { series, overlap: hasOverlap(ctx.records, keysOf) };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const PANEL_TYPES: Record<PanelType, PanelDef> = {
	activity: {
		label: "Activity over time",
		styles: [
			["stacked", "Stacked bars"],
			["grouped", "Grouped bars"],
			["lines", "Lines"],
		],
		render(el, ctx, style) {
			const { series, overlap } = timeSeries(ctx);
			const chart = el.createDiv();
			renderTimeChart(chart, { buckets: ctx.buckets, bucketLabel: ctx.bucketLabel, series, style: (style ?? "stacked") as TimeStyle });
			if (overlap && (style ?? "stacked") === "stacked") overlapNote(el);
		},
	},
	share: {
		label: "Share by category",
		styles: [
			["bars", "Ranked bars"],
			["donut", "Donut"],
		],
		render(el, ctx, style) {
			const { infos, keysOf } = seriesInfo(ctx);
			const counts = countBy(ctx.records, keysOf);
			const items = infos.map((i) => ({ ...i, value: counts.get(i.key) ?? 0 }));
			const chart = el.createDiv();
			if (style === "donut") {
				renderDonut(chart, items, ctx.records.length);
				if (hasOverlap(ctx.records, keysOf)) overlapNote(el);
			} else {
				renderRankedBars(
					chart,
					items
						.sort((a, b) => b.value - a.value)
						.map((i) => ({
							label: i.label,
							value: i.value,
							swatch: i.color,
							onClick: ctx.categories.some((c) => c.id === i.key) ? () => ctx.onSelect(i.key) : undefined,
						})),
					ctx.records.length,
				);
			}
		},
	},
	matrix: {
		label: "Category × period heatmap",
		render(el, ctx) {
			const { series } = timeSeries(ctx);
			const every = Math.ceil(ctx.buckets.length / Math.max(1, Math.floor((el.clientWidth || 600) / 60)));
			renderHeatmap(el.createDiv(), {
				rows: series.map((s) => s.label),
				cols: ctx.buckets.map(ctx.bucketLabel),
				values: series.map((s) => s.values),
				colLabelEvery: every,
				rowLabelWidth: Math.min(160, 20 + Math.max(...series.map((s) => s.label.length), 4) * 6),
				cellTitle: (ri, ci, v) => `${series[ri].label} · ${ctx.bucketLabel(ctx.buckets[ci])} · ${v}`,
			});
		},
	},
	weekhour: {
		label: "Busiest days and hours",
		render(el, ctx) {
			const grid = countByWeekdayHour(ctx.records);
			renderHeatmap(el.createDiv(), {
				rows: WEEKDAYS,
				cols: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
				values: grid,
				colLabelEvery: 3,
				cellTitle: (ri, ci, v) => `${WEEKDAYS[ri]} ${String(ci).padStart(2, "0")}:00–${String(ci).padStart(2, "0")}:59 · ${v}`,
			});
		},
	},
	calendar: {
		label: "Calendar",
		render(el, ctx) {
			const now = new Date();
			const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1);
			const from = ctx.rangeStart < yearAgo ? yearAgo : ctx.rangeStart;
			renderCalendar(el.createDiv(), countByDay(ctx.records), from, now, localIsoDate);
		},
	},
	senders: {
		label: "Top senders",
		styles: [
			["address", "By address"],
			["domain", "By domain"],
		],
		render(el, ctx, style) {
			const top = topSenders(ctx.records, style === "domain" ? "domain" : "address");
			renderRankedBars(el.createDiv(), top.map((t) => ({ label: t.label, value: t.count })), ctx.records.length);
		},
	},
	status: {
		label: "Tasks by status",
		render(el, ctx) {
			const scope = ctx.selected && ctx.selected !== UNCAT_KEY ? subtreeIds(ctx.categories, ctx.selected) : null;
			const order = { open: 0, waiting: 1, done: 2 } as const;
			const rows = ctx.categories
				.filter((c) => c.trackAsTask && (!scope || scope.has(c.id)))
				.map((c) => ({ c, s: taskState(c, ctx.allRecords), n: ctx.records.filter((r) => inCategory(r, c.id)).length }))
				.sort((a, b) => order[a.s.status] - order[b.s.status] || b.n - a.n);
			if (!rows.length) {
				el.createDiv({ cls: "ett-empty", text: "No tasks here. Turn on “Treat as a task” for a category." });
				return;
			}
			const counts = { open: 0, waiting: 0, done: 0 };
			for (const r of rows) counts[r.s.status]++;
			el.createDiv({
				cls: "ett-muted ett-chart-note",
				text: `${counts.open} open · ${counts.waiting} waiting · ${counts.done} done. Bars show emails per task in this period.`,
			});
			renderRankedBars(
				el.createDiv(),
				rows.map(({ c, s, n }) => ({
					label: c.name,
					value: Math.max(n, 0.0001),
					swatch: c.color,
					barColor: STATUS_COLORS[s.status],
					valueText: `${STATUS_LABEL[s.status]} · ${n} email${n === 1 ? "" : "s"}`,
					onClick: () => ctx.onSelect(c.id),
				})),
			);
		},
	},
};

export function panelTitle(p: PanelConfig): string {
	const def = PANEL_TYPES[p.type];
	const style = def.styles?.find(([v]) => v === p.style)?.[1];
	return style && def.styles!.length > 1 ? `${def.label} · ${style}` : def.label;
}

export interface PanelActions {
	update(patch: Partial<PanelConfig>): void;
	move(delta: -1 | 1): void;
	remove(): void;
}

export function openPanelMenu(evt: MouseEvent, p: PanelConfig, actions: PanelActions): void {
	const menu = new Menu();
	for (const [type, def] of Object.entries(PANEL_TYPES) as [PanelType, PanelDef][]) {
		menu.addItem((i) =>
			i
				.setTitle(def.label)
				.setChecked(p.type === type)
				.onClick(() => actions.update({ type, style: def.styles?.[0]?.[0] })),
		);
	}
	const styles = PANEL_TYPES[p.type].styles;
	if (styles) {
		menu.addSeparator();
		for (const [value, label] of styles) {
			menu.addItem((i) => i.setTitle(label).setChecked((p.style ?? styles[0][0]) === value).onClick(() => actions.update({ style: value })));
		}
	}
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle(p.width === "full" ? "Half width" : "Full width")
			.setIcon(p.width === "full" ? "minimize-2" : "maximize-2")
			.onClick(() => actions.update({ width: p.width === "full" ? "half" : "full" })),
	);
	menu.addItem((i) => i.setTitle("Move up").setIcon("arrow-up").onClick(() => actions.move(-1)));
	menu.addItem((i) => i.setTitle("Move down").setIcon("arrow-down").onClick(() => actions.move(1)));
	menu.addItem((i) => i.setTitle("Remove chart").setIcon("trash-2").onClick(() => actions.remove()));
	menu.showAtMouseEvent(evt);
}
