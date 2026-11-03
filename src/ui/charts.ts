import type { Series } from "../store/stats";

/** Validated categorical palette, assigned to new categories in this fixed order. */
export const CATEGORY_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const OTHER_COLOR = "#8a8984";
export const UNCATEGORIZED_COLOR = "#b5b4ae";
/** Reserved status colours; always shown with a text label. */
export const STATUS_COLORS = { open: "#ec835a", waiting: "#fab219", done: "#0ca30c" } as const;
/** Single hue for ranked bars. */
export const RANK_COLOR = "#2a78d6";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Small colour square. The colour goes in through a CSS variable, never a style string. */
export function swatch(parent: HTMLElement, color: string): HTMLElement {
	const el = parent.createSpan({ cls: "ett-swatch" });
	el.setCssProps({ "--ett-swatch-color": color });
	return el;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	return el;
}

function svgText(parent: SVGElement, text: string, attrs: Record<string, string | number>): void {
	const t = svgEl("text", attrs);
	t.textContent = text;
	parent.appendChild(t);
}

/** Rectangle with only the top corners rounded, so bars sit flat on the baseline. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
	r = Math.min(r, w / 2, h);
	return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v: number): number {
	if (v <= 4) return Math.max(1, v);
	const step = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
	return 10 * step;
}

function legend(container: HTMLElement, items: { label: string; color: string }[]): void {
	const el = container.createDiv({ cls: "ett-legend" });
	for (const s of items) {
		const item = el.createSpan({ cls: "ett-legend-item" });
		swatch(item, s.color);
		item.createSpan({ text: s.label });
	}
}

export function emptyState(container: HTMLElement, text = "No emails in this period."): void {
	container.createDiv({ cls: "ett-empty", text });
}

export function overlapNote(container: HTMLElement): void {
	container.createDiv({
		cls: "ett-muted ett-chart-note",
		text: "Some emails are in more than one category, so the parts can add up to more than the total.",
	});
}

interface Tooltip {
	show(xPct: number, title: string, rows: { label: string; color?: string; value: string }[]): void;
	hide(): void;
}

function tooltip(wrap: HTMLElement): Tooltip {
	const el = wrap.createDiv({ cls: "ett-tooltip" });
	return {
		show(xPct, title, rows) {
			el.empty();
			el.createDiv({ cls: "ett-tooltip-title", text: title });
			for (const r of rows) {
				const row = el.createDiv({ cls: "ett-tooltip-row" });
				if (r.color) swatch(row, r.color);
				row.createSpan({ text: r.label });
				row.createSpan({ cls: "ett-tooltip-value", text: r.value });
			}
			el.setCssProps({ "--ett-tooltip-left": `${Math.min(75, Math.max(0, xPct))}%` });
			el.addClass("is-visible");
		},
		hide() {
			el.removeClass("is-visible");
		},
	};
}

// ── Over time: stacked bars, grouped bars, lines ──────────────────────────

export type TimeStyle = "stacked" | "grouped" | "lines";

export interface TimeChartOptions {
	buckets: string[];
	bucketLabel: (key: string) => string;
	series: Series[];
	style: TimeStyle;
	height?: number;
}

export function renderTimeChart(container: HTMLElement, opts: TimeChartOptions): void {
	container.empty();
	const { buckets, series, style } = opts;
	const totals = buckets.map((_, i) => series.reduce((s, ser) => s + ser.values[i], 0));
	if (series.length > 1) legend(container, series);
	if (!totals.some(Boolean)) return emptyState(container);

	const width = Math.max(320, container.clientWidth || 640);
	const height = opts.height ?? 220;
	const pad = { top: 8, right: 8, bottom: 24, left: 32 };
	const plotW = width - pad.left - pad.right;
	const plotH = height - pad.top - pad.bottom;
	const peak = style === "stacked" ? Math.max(...totals) : Math.max(...series.flatMap((s) => s.values));
	const max = niceMax(peak);
	const slot = plotW / buckets.length;
	const y = (v: number) => pad.top + plotH - (v / max) * plotH;
	const cx = (i: number) => pad.left + slot * i + slot / 2;

	const wrap = container.createDiv({ cls: "ett-chart" });
	const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
	svg.setAttribute("aria-label", `Email activity, ${totals.reduce((a, b) => a + b, 0)} emails`);
	wrap.appendChild(svg);

	const ticks = max <= 4 ? max : 4;
	for (let i = 0; i <= ticks; i++) {
		const v = (max / ticks) * i;
		svg.appendChild(svgEl("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: i ? "ett-grid" : "ett-axis" }));
		svgText(svg, String(Math.round(v * 10) / 10), { x: pad.left - 6, y: y(v) + 4, "text-anchor": "end", class: "ett-tick" });
	}
	const labelEvery = Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 70)));
	buckets.forEach((key, i) => {
		if (i % labelEvery === 0) svgText(svg, opts.bucketLabel(key), { x: cx(i), y: height - 6, "text-anchor": "middle", class: "ett-tick" });
	});

	if (style === "stacked") {
		const barW = Math.max(2, Math.min(28, slot * 0.7));
		buckets.forEach((_, i) => {
			let acc = 0;
			const stack = series.map((s, si) => ({ v: s.values[i], si })).filter((p) => p.v > 0);
			stack.forEach(({ v, si }, idx) => {
				const top = y(acc + v);
				const bottom = y(acc);
				acc += v;
				// 2px surface gap between stacked segments.
				const h = Math.max(1, bottom - top - (idx > 0 ? 2 : 0));
				const x = cx(i) - barW / 2;
				const d = idx === stack.length - 1 ? topRoundedRect(x, top, barW, h, 4) : `M${x},${top}h${barW}v${h}h${-barW}Z`;
				svg.appendChild(svgEl("path", { d, fill: series[si].color }));
			});
		});
	} else if (style === "grouped") {
		const groupW = Math.max(2, slot * 0.8);
		const gap = series.length > 1 ? 2 : 0;
		const barW = Math.max(1, (groupW - gap * (series.length - 1)) / series.length);
		buckets.forEach((_, i) => {
			series.forEach((s, si) => {
				const v = s.values[i];
				if (!v) return;
				const x = cx(i) - groupW / 2 + si * (barW + gap);
				svg.appendChild(svgEl("path", { d: topRoundedRect(x, y(v), barW, y(0) - y(v), Math.min(4, barW / 2)), fill: s.color }));
			});
		});
	} else {
		for (const s of series) {
			const d = s.values.map((v, i) => `${i ? "L" : "M"}${cx(i)},${y(v)}`).join("");
			svg.appendChild(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
		}
	}

	// Hover layer: full-height hit targets per bucket; lines get a crosshair and markers.
	const tip = tooltip(wrap);
	const cross = svgEl("line", { x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH, class: "ett-crosshair" });
	const markers = svgEl("g", {});
	if (style === "lines") svg.append(cross, markers);
	buckets.forEach((key, i) => {
		const hit = svgEl("rect", { x: pad.left + slot * i, y: pad.top, width: slot, height: plotH, class: "ett-hit" });
		hit.addEventListener("mouseenter", () => {
			const rows = series.filter((s) => s.values[i] || style === "lines").map((s) => ({ label: s.label, color: s.color, value: String(s.values[i]) }));
			tip.show((cx(i) / width) * 100, `${opts.bucketLabel(key)} · ${totals[i]}`, rows);
			if (style === "lines") {
				cross.setAttribute("x1", String(cx(i)));
				cross.setAttribute("x2", String(cx(i)));
				cross.addClass("is-visible");
				markers.replaceChildren(
					...series.map((s) => svgEl("circle", { cx: cx(i), cy: y(s.values[i]), r: 4, fill: s.color, class: "ett-marker" })),
				);
			} else hit.addClass("is-hover");
		});
		hit.addEventListener("mouseleave", () => {
			tip.hide();
			hit.removeClass("is-hover");
			cross.removeClass("is-visible");
			markers.replaceChildren();
		});
		svg.appendChild(hit);
	});
}

// ── Ranked horizontal bars (HTML) ─────────────────────────────────────────

export interface RankItem {
	label: string;
	value: number;
	/** Identity swatch next to the label; the bar itself uses one hue. */
	swatch?: string;
	/** Override the bar colour, e.g. a status colour (always paired with valueText). */
	barColor?: string;
	/** Replaces the number shown at the end of the row. */
	valueText?: string;
	onClick?: () => void;
}

export function renderRankedBars(container: HTMLElement, items: RankItem[], total?: number): void {
	container.empty();
	const shown = items.filter((i) => i.value > 0);
	if (!shown.length) return emptyState(container);
	const max = Math.max(...shown.map((i) => i.value));
	const list = container.createDiv({ cls: "ett-rank" });
	for (const it of shown) {
		const row = list.createDiv({ cls: "ett-rank-row" + (it.onClick ? " is-link" : "") });
		const label = row.createDiv({ cls: "ett-rank-label" });
		if (it.swatch) swatch(label, it.swatch);
		label.createSpan({ text: it.label });
		const track = row.createDiv({ cls: "ett-rank-track" });
		const bar = track.createDiv({ cls: "ett-rank-bar" });
		bar.setCssProps({ "--ett-bar-width": `${(it.value / max) * 100}%`, "--ett-bar-color": it.barColor ?? RANK_COLOR });
		const pct = total ? ` · ${Math.round((it.value / total) * 100)}%` : "";
		const text = it.valueText ?? `${it.value}${pct}`;
		row.createDiv({ cls: "ett-rank-value", text });
		row.title = `${it.label}: ${text}`;
		if (it.onClick) row.addEventListener("click", it.onClick);
	}
}

// ── Donut ─────────────────────────────────────────────────────────────────

export interface SliceItem {
	label: string;
	value: number;
	color: string;
}

const MAX_SLICES = 6;

export function renderDonut(container: HTMLElement, items: SliceItem[], emailCount: number): void {
	container.empty();
	let slices = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
	if (!slices.length) return emptyState(container);
	if (slices.length > MAX_SLICES) {
		const rest = slices.slice(MAX_SLICES - 1);
		slices = [...slices.slice(0, MAX_SLICES - 1), { label: "Other", value: rest.reduce((s, r) => s + r.value, 0), color: OTHER_COLOR }];
	}
	const sum = slices.reduce((s, r) => s + r.value, 0);
	const wrap = container.createDiv({ cls: "ett-donut-wrap" });
	const size = 180;
	const r = 80;
	const inner = 52;
	const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img" });
	svg.setAttribute("aria-label", `Share by category, ${emailCount} emails`);
	const chart = wrap.createDiv({ cls: "ett-chart ett-donut" });
	chart.appendChild(svg);
	const tip = tooltip(chart);

	let angle = -Math.PI / 2;
	const c = size / 2;
	const pt = (a: number, rad: number) => `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`;
	for (const s of slices) {
		const sweep = (s.value / sum) * Math.PI * 2;
		const end = angle + sweep;
		const large = sweep > Math.PI ? 1 : 0;
		const d =
			slices.length === 1
				? `M${c},${c - r}A${r},${r} 0 1 1 ${c - 0.01},${c - r}L${c - 0.01},${c - inner}A${inner},${inner} 0 1 0 ${c},${c - inner}Z`
				: `M${pt(angle, r)}A${r},${r} 0 ${large} 1 ${pt(end, r)}L${pt(end, inner)}A${inner},${inner} 0 ${large} 0 ${pt(angle, inner)}Z`;
		// The stroke in the surface colour makes the 2px gap between slices.
		const path = svgEl("path", { d, fill: s.color, class: "ett-slice" });
		path.addEventListener("mouseenter", () =>
			tip.show(50, s.label, [{ label: "Emails", value: `${s.value} · ${Math.round((s.value / sum) * 100)}%` }]),
		);
		path.addEventListener("mouseleave", () => tip.hide());
		svg.appendChild(path);
		angle = end;
	}
	svgText(svg, String(emailCount), { x: c, y: c + 2, "text-anchor": "middle", class: "ett-donut-total" });
	svgText(svg, "emails", { x: c, y: c + 18, "text-anchor": "middle", class: "ett-tick" });

	const keys = wrap.createDiv({ cls: "ett-donut-legend" });
	for (const s of slices) {
		const row = keys.createDiv({ cls: "ett-legend-item" });
		swatch(row, s.color);
		row.createSpan({ text: s.label });
		row.createSpan({ cls: "ett-tooltip-value", text: `${s.value} · ${Math.round((s.value / sum) * 100)}%` });
	}
}

// ── Heatmaps ──────────────────────────────────────────────────────────────

/** Map a count to a ramp step 0–5 (0 = empty). */
function heatStep(v: number, max: number): number {
	if (!v || !max) return 0;
	return Math.min(5, Math.max(1, Math.ceil((v / max) * 5)));
}

function heatLegend(container: HTMLElement, max: number): void {
	const el = container.createDiv({ cls: "ett-heat-legend" });
	el.createSpan({ text: "0" });
	for (let s = 0; s <= 5; s++) el.createSpan({ cls: `ett-heat-swatch ett-heat-${s}` });
	el.createSpan({ text: String(max) });
}

export interface HeatmapOptions {
	rows: string[];
	cols: string[];
	values: number[][];
	/** Show every nth column label. */
	colLabelEvery?: number;
	cellTitle: (row: number, col: number, v: number) => string;
	rowLabelWidth?: number;
}

export function renderHeatmap(container: HTMLElement, opts: HeatmapOptions): void {
	container.empty();
	const max = Math.max(0, ...opts.values.flat());
	if (!max) return emptyState(container);
	const labelW = opts.rowLabelWidth ?? 40;
	const width = Math.max(320, container.clientWidth || 640);
	const cell = Math.max(8, Math.min(28, (width - labelW - 4) / opts.cols.length));
	const gap = 2;
	const height = opts.rows.length * cell + 18;
	const chart = container.createDiv({ cls: "ett-chart" });
	const svg = svgEl("svg", { viewBox: `0 0 ${labelW + opts.cols.length * cell} ${height}`, width: "100%", role: "img" });
	svg.addClass("ett-heatmap");
	svg.setCssProps({ "--ett-heatmap-width": `${labelW + opts.cols.length * cell}px` });
	chart.appendChild(svg);
	const tip = tooltip(chart);
	const every = opts.colLabelEvery ?? 1;

	opts.rows.forEach((row, ri) => {
		svgText(svg, row, { x: labelW - 6, y: ri * cell + cell / 2 + 4, "text-anchor": "end", class: "ett-tick" });
		opts.cols.forEach((_, ci) => {
			const v = opts.values[ri][ci];
			const rect = svgEl("rect", {
				x: labelW + ci * cell,
				y: ri * cell,
				width: cell - gap,
				height: cell - gap,
				rx: 3,
				class: `ett-heat-${heatStep(v, max)}`,
			});
			rect.addEventListener("mouseenter", () => {
				tip.show(((labelW + ci * cell) / (labelW + opts.cols.length * cell)) * 100, opts.cellTitle(ri, ci, v), []);
				rect.addClass("is-hover");
			});
			rect.addEventListener("mouseleave", () => {
				tip.hide();
				rect.removeClass("is-hover");
			});
			svg.appendChild(rect);
		});
	});
	opts.cols.forEach((col, ci) => {
		if (ci % every === 0)
			svgText(svg, col, { x: labelW + ci * cell + (cell - gap) / 2, y: height - 4, "text-anchor": "middle", class: "ett-tick" });
	});
	heatLegend(container, max);
}

/** GitHub-style calendar: one column per week, Monday at the top. */
export function renderCalendar(container: HTMLElement, counts: Map<string, number>, from: Date, to: Date, keyOf: (d: Date) => string): void {
	const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
	start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
	const weeks: Date[] = [];
	for (const d = new Date(start); d <= to && weeks.length < 60; d.setDate(d.getDate() + 7)) weeks.push(new Date(d));
	const values = Array.from({ length: 7 }, (_, wd) =>
		weeks.map((w) => {
			const day = new Date(w);
			day.setDate(day.getDate() + wd);
			return day > to || day < from ? 0 : counts.get(keyOf(day)) ?? 0;
		}),
	);
	const cols = weeks.map((w, i) =>
		i === 0 || w.getMonth() !== weeks[i - 1].getMonth() ? w.toLocaleDateString(undefined, { month: "short" }) : "",
	);
	renderHeatmap(container, {
		rows: ["Mon", "", "Wed", "", "Fri", "", "Sun"],
		cols,
		values,
		cellTitle: (ri, ci, v) => {
			const day = new Date(weeks[ci]);
			day.setDate(day.getDate() + ri);
			return `${day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${v} email${v === 1 ? "" : "s"}`;
		},
	});
}
