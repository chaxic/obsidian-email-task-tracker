import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type EmailTrackerPlugin from "../main";
import type { Category, DateGranularity, EmailRecord, PanelConfig, PanelType, TaskStatus } from "../types";
import {
	categoryDisplayName,
	childrenOf,
	inCategory,
	pathLabel,
	sortedByDisplayName,
	subtreeIds,
} from "../classify/engine";
import { tasksOf, taskState, type TaskSignal, type TaskState } from "../classify/tasks";
import { UNCAT_KEY, bucketRange, daysBetween, localIsoDate } from "../store/stats";
import { UNCATEGORIZED_COLOR, swatch } from "./charts";
import { CategoryModal } from "./CategoryModal";
import { CategoryPickerModal } from "./CategoryPickerModal";
import { ConfirmModal } from "./ConfirmModal";
import { PANEL_TYPES, openPanelMenu, panelTitle, type PanelContext } from "./panels";
import { confirmDeleteCategory, openCategoryMenu } from "./categoryActions";
import { STATUS_LABEL, statusBadge, taskIcon } from "./icons";

export const VIEW_TYPE = "email-task-tracker-dashboard";

const ALL = "__all__";
const PAGE = 100;

type RangePreset = "30" | "90" | "365" | "all";
type StatusFilter = "any" | TaskStatus | "active";

export class DashboardView extends ItemView {
	private selected = ALL;
	private status: StatusFilter = "any";
	private range: RangePreset = "90";
	private granularity: DateGranularity | "auto" = "auto";
	private search = "";
	private limit = PAGE;
	private panelsEl: HTMLElement | null = null;
	/** Task states for this render, keyed by category id. */
	private states = new Map<string, TaskState>();
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: EmailTrackerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Email tracker";
	}

	getIcon(): string {
		return "mail";
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.plugin.store.onChange(() => this.render());
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
	}

	onResize(): void {
		if (this.panelsEl && !this.plugin.store.locked) this.renderPanels(this.panelsEl, this.filtered());
	}

	private get categories(): Category[] {
		return this.plugin.categories;
	}

	// ── Filtering ───────────────────────────────────────────────────────────

	private rangeStart(): Date | null {
		if (this.range === "all") return null;
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() - Number(this.range) + 1);
		return d;
	}

	private inSelection(r: EmailRecord): boolean {
		if (this.selected === ALL) return true;
		if (this.selected === UNCAT_KEY) return r.paths.length === 0;
		return inCategory(r, this.selected);
	}

	/** Status applies to tasks: an email matches if any task it belongs to has that status. */
	private matchesTaskStatus(status: TaskStatus | undefined): boolean {
		if (this.status === "any") return true;
		if (!status) return false;
		if (this.status === "active") return status === "open" || status === "waiting";
		return status === this.status;
	}

	private matchesStatus(r: EmailRecord): boolean {
		if (this.status === "any") return true;
		return tasksOf(this.categories, r).some((t) => this.matchesTaskStatus(this.states.get(t.id)?.status));
	}

	private matchesSearch(r: EmailRecord): boolean {
		const q = this.search.trim().toLowerCase();
		if (!q) return true;
		return [r.subject ?? "", r.from, ...r.keywords, ...r.matchedKeywords, ...(r.statusPhrases ?? [])].some((s) =>
			s.toLowerCase().includes(q),
		);
	}

	private filtered(): EmailRecord[] {
		const start = this.rangeStart();
		return this.plugin.store.records.filter(
			(r) => this.inSelection(r) && this.matchesStatus(r) && this.matchesSearch(r) && (!start || new Date(r.date) >= start),
		);
	}

	private effectiveGranularity(): DateGranularity {
		if (this.granularity !== "auto") return this.granularity;
		const cat = this.categories.find((c) => c.id === this.selected);
		if (cat) return cat.dateGranularity;
		return this.range === "30" ? "day" : this.range === "90" ? "week" : "month";
	}

	/** Wait on a save started from the dashboard; a failed write must not go unnoticed. */
	private persist(saving: Promise<void>): void {
		saving.catch(() => new Notice("Email Task Tracker could not save your change. Try again."));
	}

	// ── Render ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("ett-dashboard");
		if (this.plugin.store.locked) return this.renderLocked(root);
		if (this.selected !== ALL && this.selected !== UNCAT_KEY && !this.categories.some((c) => c.id === this.selected)) {
			this.selected = ALL;
		}

		this.states = new Map(
			this.categories.filter((c) => c.trackAsTask).map((c) => [c.id, taskState(c, this.plugin.store.records)]),
		);
		this.renderHeader(root);
		this.renderDropZone(root);
		const records = this.filtered();
		this.renderKpis(root, records);
		this.renderFilters(root);

		const layout = root.createDiv({ cls: "ett-layout" });
		this.renderTree(layout.createDiv({ cls: "ett-card ett-side" }));
		const main = layout.createDiv({ cls: "ett-main" });
		this.renderTasks(main);
		this.panelsEl = main.createDiv({ cls: "ett-panels" });
		this.renderPanels(this.panelsEl, records);
		this.renderTable(main, records);
	}

	private renderLocked(root: HTMLElement): void {
		const box = root.createDiv({ cls: "ett-locked" });
		setIcon(box.createDiv({ cls: "ett-locked-icon" }), "lock");
		box.createEl("h3", { text: "Email tracker is locked" });
		box.createDiv({ cls: "ett-muted", text: "Your categories and records are encrypted on disk." });
		const b = box.createEl("button", { cls: "mod-cta", text: "Unlock" });
		b.addEventListener("click", () => void this.plugin.ensureUnlocked());
	}

	private selectionLabel(): string {
		if (this.selected === ALL) return "All emails";
		if (this.selected === UNCAT_KEY) return "Uncategorized";
		return categoryDisplayName(this.categories, this.selected);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "ett-header" });
		header.createEl("h2", { text: "Email tracker" });
		const actions = header.createDiv({ cls: "ett-actions" });
		const button = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
			const b = actions.createEl("button", { attr: { "aria-label": label } });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", onClick);
		};
		button("folder-plus", "New category", () => new CategoryModal(this.plugin, { parentId: null }).open());
		button("settings", "Manage categories", () => this.plugin.openSettings());
		button("bar-chart-3", "Add chart", () => void this.addPanel());
		button("refresh-cw", "Re-run filters", () => void this.plugin.rerunFilters());
		button("download", "Export CSV", () => void this.plugin.exportCsv());
		if (this.plugin.store.encrypted) button("lock", "Lock", () => void this.plugin.lock());
	}

	private renderDropZone(root: HTMLElement): void {
		const zone = root.createDiv({ cls: "ett-drop" });
		setIcon(zone.createSpan({ cls: "ett-drop-icon" }), "mail-plus");
		const text = zone.createDiv();
		text.createDiv({ cls: "ett-drop-title", text: "Drop emails here, or click to choose files" });
		text.createDiv({
			cls: "ett-muted",
			text: "Outlook: drag a message here (or to a folder first). Gmail: ⋮ › Download message, then drop the .eml file. Only a reference is saved.",
		});
		zone.addEventListener("click", () => this.plugin.pickFiles());
		// The plugin's window-level handler performs the import; this only signals a valid target.
		zone.addEventListener("dragover", (e) => {
			e.preventDefault();
			zone.addClass("is-over");
		});
		zone.addEventListener("dragleave", () => zone.removeClass("is-over"));
		zone.addEventListener("drop", () => zone.removeClass("is-over"));
	}

	private renderKpis(root: HTMLElement, records: EmailRecord[]): void {
		const all = this.plugin.store.records;
		const weekAgo = Date.now() - 7 * 86_400_000;
		const active = this.visibleTasks().filter(([, s]) => s.status !== "done" && s.opened);
		const now = new Date();
		const avgOpen = active.length ? active.reduce((sum, [, s]) => sum + daysBetween(s.opened!, now), 0) / active.length : null;

		const row = root.createDiv({ cls: "ett-kpis" });
		const tile = (label: string, value: string, onClick?: () => void) => {
			const t = row.createDiv({ cls: "ett-kpi" + (onClick ? " is-link" : "") });
			t.createDiv({ cls: "ett-kpi-value", text: value });
			t.createDiv({ cls: "ett-kpi-label", text: label });
			if (onClick) t.addEventListener("click", onClick);
		};
		tile(this.range === "all" ? "Emails" : `Emails, last ${this.range} days`, String(records.length));
		tile("This week", String(records.filter((r) => new Date(r.date).getTime() >= weekAgo).length));
		tile("Uncategorized", String(all.filter((r) => r.paths.length === 0).length), () => {
			this.selected = UNCAT_KEY;
			this.status = "any";
			this.render();
		});
		tile("Open tasks", String(active.length), () => {
			this.status = "active";
			this.render();
		});
		tile("Avg days open", avgOpen === null ? "–" : avgOpen.toFixed(1));
	}

	private renderFilters(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "ett-filters" });
		const select = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
			const wrap = bar.createEl("label", { cls: "ett-filter" });
			wrap.createSpan({ text: label });
			const sel = wrap.createEl("select", { cls: "dropdown" });
			for (const [v, text] of options) sel.createEl("option", { value: v, text });
			sel.value = value;
			sel.addEventListener("change", () => onChange(sel.value));
		};

		select(
			"Category",
			[
				[ALL, "All"],
				[UNCAT_KEY, "Uncategorized"],
				...sortedByDisplayName(this.categories).map(
					(c) => [c.id, `${c.trackAsTask ? "☑ " : ""}${categoryDisplayName(this.categories, c.id)}`] as [string, string],
				),
			],
			this.selected,
			(v) => {
				this.selected = v;
				this.limit = PAGE;
				this.render();
			},
		);
		select(
			"Status",
			[
				["any", "Any"],
				["active", "Open or waiting"],
				["open", "Open"],
				["waiting", "Waiting"],
				["done", "Done"],
			],
			this.status,
			(v) => {
				this.status = v as StatusFilter;
				this.render();
			},
		);
		select(
			"Period",
			[
				["30", "Last 30 days"],
				["90", "Last 90 days"],
				["365", "Last 12 months"],
				["all", "All time"],
			],
			this.range,
			(v) => {
				this.range = v as RangePreset;
				this.render();
			},
		);
		select(
			"Group by",
			[
				["auto", "Auto"],
				["day", "Day"],
				["week", "Week"],
				["month", "Month"],
			],
			this.granularity,
			(v) => {
				this.granularity = v as DateGranularity | "auto";
				this.render();
			},
		);

		const searchWrap = bar.createEl("label", { cls: "ett-filter ett-search" });
		searchWrap.createSpan({ text: "Search" });
		const input = searchWrap.createEl("input", { type: "search", placeholder: "Subject, sender or keyword" });
		input.value = this.search;
		let timer: number | null = null;
		input.addEventListener("input", () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				this.search = input.value;
				this.render();
				const again = this.contentEl.querySelector<HTMLInputElement>(".ett-search input");
				again?.focus();
				again?.setSelectionRange(again.value.length, again.value.length);
			}, 250);
		});
	}

	// ── Panels ──────────────────────────────────────────────────────────────

	private panelContext(records: EmailRecord[]): PanelContext {
		const g = this.effectiveGranularity();
		const start = this.rangeStart() ?? earliest(records);
		return {
			records,
			allRecords: this.plugin.store.records,
			categories: this.categories,
			selected: this.selected === ALL ? null : this.selected,
			buckets: bucketRange(start, new Date(), g),
			granularity: g,
			bucketLabel: (k) => formatBucket(k, g),
			rangeStart: start,
			onSelect: (id) => {
				this.selected = id;
				this.limit = PAGE;
				this.render();
			},
		};
	}

	private renderPanels(el: HTMLElement, records: EmailRecord[]): void {
		el.empty();
		const panels = this.plugin.settings.dashboardPanels;
		if (!panels.length) {
			const empty = el.createDiv({ cls: "ett-card ett-empty" });
			empty.setText("No charts. Use “Add chart” to add one.");
			return;
		}
		// Charts measure their container, so lay out the cards before drawing.
		const cards = panels.map((p) => {
			const card = el.createDiv({ cls: `ett-card ett-panel is-${p.width}` });
			const head = card.createDiv({ cls: "ett-card-head" });
			head.createDiv({ cls: "ett-card-title", text: `${panelTitle(p)} · ${this.selectionLabel()}` });
			const menu = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Chart options" } });
			setIcon(menu, "more-horizontal");
			menu.addEventListener("click", (e) => openPanelMenu(e, p, this.panelActions(p)));
			return { p, body: card.createDiv({ cls: "ett-panel-body" }) };
		});
		const ctx = this.panelContext(records);
		for (const { p, body } of cards) PANEL_TYPES[p.type].render(body, ctx, p.style);
	}

	private panelActions(p: PanelConfig) {
		const save = async (panels: PanelConfig[]) => {
			this.plugin.settings.dashboardPanels = panels;
			await this.plugin.saveSettings();
		};
		const panels = () => this.plugin.settings.dashboardPanels;
		return {
			update: (patch: Partial<PanelConfig>) => void save(panels().map((x) => (x.id === p.id ? { ...x, ...patch } : x))),
			move: (delta: -1 | 1) => {
				const list = [...panels()];
				const i = list.findIndex((x) => x.id === p.id);
				const j = i + delta;
				if (j < 0 || j >= list.length) return;
				[list[i], list[j]] = [list[j], list[i]];
				void save(list);
			},
			remove: () => void save(panels().filter((x) => x.id !== p.id)),
		};
	}

	private async addPanel(): Promise<void> {
		const used = new Set(this.plugin.settings.dashboardPanels.map((p) => p.type));
		const type = (Object.keys(PANEL_TYPES) as PanelType[]).find((t) => !used.has(t)) ?? "activity";
		const panel: PanelConfig = { id: `p-${Date.now()}`, type, style: PANEL_TYPES[type].styles?.[0]?.[0], width: "half" };
		this.plugin.settings.dashboardPanels = [...this.plugin.settings.dashboardPanels, panel];
		await this.plugin.saveSettings();
		new Notice(`Added “${PANEL_TYPES[type].label}”. Use its ⋯ menu to change the chart type.`);
	}

	// ── Category tree ───────────────────────────────────────────────────────

	private renderTree(card: HTMLElement): void {
		card.createDiv({ cls: "ett-card-title", text: "Categories" });
		const start = this.rangeStart();
		const inRange = this.plugin.store.records.filter((r) => !start || new Date(r.date) >= start);
		// Count per placement: a record counts under every route prefix it sits on.
		const placement = new Map<string, number>();
		for (const r of inRange) {
			const keys = new Set<string>();
			for (const p of r.paths) for (let i = 1; i <= p.length; i++) keys.add(p.slice(0, i).join("/"));
			for (const k of keys) placement.set(k, (placement.get(k) ?? 0) + 1);
		}

		const list = card.createDiv({ cls: "ett-tree" });
		const row = (key: string, label: string, count: number, depth: number, color?: string, cat?: Category, parentId?: string | null) => {
			const el = list.createDiv({ cls: "ett-tree-row" + (this.selected === key ? " is-selected" : "") });
			el.setCssProps({ "--ett-depth": String(depth) });
			if (color) swatch(el, color);
			el.createSpan({ cls: "ett-tree-label", text: label });
			if (cat) taskIcon(el, cat);
			if (cat) {
				const tools = el.createSpan({ cls: "ett-tree-tools" });
				const tool = (icon: string, tip: string, fn: () => void) => {
					const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tip } });
					setIcon(b, icon);
					b.addEventListener("click", (e) => {
						e.stopPropagation();
						fn();
					});
				};
				tool("pencil", "Edit", () => new CategoryModal(this.plugin, { category: cat }).open());
				tool("plus", "Add child category", () => new CategoryModal(this.plugin, { parentId: cat.id }).open());
				tool("trash-2", "Delete", () => confirmDeleteCategory(this.plugin, cat));
				el.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					openCategoryMenu(e, this.plugin, cat, parentId ?? null);
				});
			}
			el.createSpan({ cls: "ett-tree-count", text: String(count) });
			el.addEventListener("click", () => {
				this.selected = key;
				this.limit = PAGE;
				this.render();
			});
		};

		row(ALL, "All emails", inRange.length, 0);
		const walk = (parentId: string | null, chain: string[]) => {
			for (const c of childrenOf(this.categories, parentId)) {
				if (chain.includes(c.id)) continue;
				const here = [...chain, c.id];
				row(c.id, c.name, placement.get(here.join("/")) ?? 0, chain.length, c.color, c, parentId);
				walk(c.id, here);
			}
		};
		walk(null, []);
		row(UNCAT_KEY, "Uncategorized", inRange.filter((r) => r.paths.length === 0).length, 0, UNCATEGORIZED_COLOR);
		card.createDiv({
			cls: "ett-muted ett-tree-hint",
			text: this.categories.length
				? "Hover a category to edit it, or right-click for more."
				: "Create a category, or open an uncategorized email and build a filter from it.",
		});
	}

	// ── Tasks ───────────────────────────────────────────────────────────────

	/** Tasks under the current selection that pass the status and search filters. */
	private visibleTasks(): [Category, TaskState][] {
		if (this.selected === UNCAT_KEY) return [];
		const scope = this.selected === ALL ? null : subtreeIds(this.categories, this.selected);
		const q = this.search.trim().toLowerCase();
		return sortedByDisplayName(this.categories)
			.filter((c) => c.trackAsTask && (!scope || scope.has(c.id)))
			.map((c) => [c, this.states.get(c.id)!] as [Category, TaskState])
			.filter(([, s]) => this.matchesTaskStatus(s.status))
			.filter(([c, s]) => !q || c.name.toLowerCase().includes(q) || s.events.some((e) => this.matchesSearch(e.record)));
	}

	private renderTasks(root: HTMLElement): void {
		if (!this.states.size) return;
		const tasks = this.visibleTasks();
		const card = root.createDiv({ cls: "ett-card ett-tasks" });
		const title = card.createDiv({ cls: "ett-card-head" }).createDiv({ cls: "ett-card-title" });
		taskIcon(title);
		title.createSpan({ text: `Tasks · ${tasks.length}` });
		if (!tasks.length) {
			card.createDiv({ cls: "ett-empty", text: "No tasks match these filters." });
			return;
		}
		const now = new Date();
		const today = localIsoDate(now);
		const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
		const table = card.createDiv({ cls: "ett-table-wrap" }).createEl("table", { cls: "ett-table ett-task-table" });
		const hr = table.createEl("thead").createEl("tr");
		for (const h of ["Task", "Status", "Set status", "Progress", "Emails", "Last activity", "Days open", "Due"]) hr.createEl("th", { text: h });
		const body = table.createEl("tbody");

		for (const [cat, s] of tasks) {
			const tr = body.createEl("tr", { cls: this.selected === cat.id ? "is-selected" : "" });
			const name = tr.createEl("td", { cls: "ett-task-name", attr: { title: "Show this task's emails" } });
			swatch(name, cat.color);
			name.createSpan({ text: categoryDisplayName(this.categories, cat.id) });
			name.addEventListener("click", () => {
				this.selected = cat.id;
				this.limit = PAGE;
				this.render();
			});

			const statusCell = tr.createEl("td");
			statusBadge(statusCell, s.status);
			const why =
				s.source === "auto" && s.lastSignal
					? `“${s.lastSignal.phrase}” on ${fmt(s.lastSignal.at)}`
					: s.source === "manual"
						? "set by you"
						: "no status emails yet";
			statusCell.createDiv({ cls: "ett-muted", text: why });

			const sel = tr.createEl("td").createEl("select", { cls: "dropdown" });
			for (const [v, text] of [["auto", "Automatic"], ["open", "Open"], ["waiting", "Waiting"], ["done", "Done"]]) {
				sel.createEl("option", { value: v, text });
			}
			sel.value = s.source === "manual" ? s.status : "auto";
			sel.addEventListener("change", () => {
				this.persist(this.plugin.setTaskOverride(cat.id, sel.value === "auto" ? null : (sel.value as TaskStatus)));
			});

			const prog = tr.createEl("td", { cls: "ett-progress" });
			if (s.milestones.length) {
				const reached = s.milestones.filter((m) => m.reachedAt).length;
				const dots = prog.createSpan({ cls: "ett-dots" });
				for (const m of s.milestones) dots.createSpan({ cls: "ett-dot" + (m.reachedAt ? " is-reached" : "") });
				prog.createSpan({ cls: "ett-muted", text: ` ${reached}/${s.milestones.length}` });
				prog.title = s.milestones
					.map((m) => `${m.reachedAt ? "✓" : "○"} ${m.phrase}${m.reachedAt ? ` (${fmt(m.reachedAt)})` : ""}`)
					.join("\n");
			} else prog.createSpan({ cls: "ett-muted", text: "—" });

			tr.createEl("td", { text: String(s.emailCount) });
			tr.createEl("td", { cls: "ett-nowrap", text: s.lastActivity ? fmt(s.lastActivity) : "—" });
			const end = s.status === "done" && s.lastSignal ? s.lastSignal.at : now;
			tr.createEl("td", { text: s.opened ? String(Math.floor(daysBetween(s.opened, end))) : "—" });

			const dueCell = tr.createEl("td");
			const due = dueCell.createEl("input", { type: "date", cls: "ett-due" });
			due.value = cat.due ?? "";
			if (cat.due && cat.due < today && s.status !== "done") {
				dueCell.addClass("is-overdue");
				due.title = "Overdue";
			}
			due.addEventListener("change", () => this.persist(this.plugin.setTaskDue(cat.id, due.value || undefined)));
		}
		card.createDiv({
			cls: "ett-muted ett-tree-hint",
			text: `Status follows the newest email with a status phrase (e.g. “resolved” → ${STATUS_LABEL.done}). Click a task to see its emails as a timeline.`,
		});
	}

	// ── Table ───────────────────────────────────────────────────────────────

	private renderTable(root: HTMLElement, records: EmailRecord[]): void {
		const card = root.createDiv({ cls: "ett-card" });
		card.createDiv({ cls: "ett-card-title", text: `Emails · ${records.length}` });
		if (!records.length) {
			card.createDiv({ cls: "ett-empty", text: "Nothing to show for these filters." });
			return;
		}
		const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
		const wrap = card.createDiv({ cls: "ett-table-wrap" });
		const table = wrap.createEl("table", { cls: "ett-table" });
		const head = table.createEl("thead").createEl("tr");
		for (const h of ["Date", "Categories", "From", "Subject", "Signal", ""]) head.createEl("th", { text: h });
		const body = table.createEl("tbody");
		const byId = new Map(this.categories.map((c) => [c.id, c]));
		// What each email contributed to its tasks, from this render's task states.
		const contributions = new Map<string, { task: Category; signal: TaskSignal | null; milestones: string[] }[]>();
		for (const [id, state] of this.states) {
			const task = byId.get(id)!;
			for (const e of state.events) {
				if (!e.signal && !e.milestones.length) continue;
				const list = contributions.get(e.record.id) ?? [];
				list.push({ task, signal: e.signal, milestones: e.milestones });
				contributions.set(e.record.id, list);
			}
		}

		for (const r of sorted.slice(0, this.limit)) {
			const tr = body.createEl("tr");
			tr.createEl("td", { cls: "ett-nowrap", text: new Date(r.date).toLocaleDateString() });

			const catCell = tr.createEl("td", { cls: "ett-cat-cell" });
			if (!r.paths.length) catCell.createSpan({ cls: "ett-cat-chip is-uncat", text: "Uncategorized" });
			for (const p of r.paths) {
				const chip = catCell.createSpan({ cls: "ett-cat-chip", text: pathLabel(this.categories, p) });
				const leaf = byId.get(p[p.length - 1]);
				if (leaf) chip.setCssProps({ "--chip-color": leaf.color });
				if (p.some((id) => byId.get(id)?.trackAsTask)) taskIcon(chip);
			}
			const edit = catCell.createEl("button", {
				cls: "clickable-icon ett-cat-edit",
				attr: { "aria-label": r.manual ? "Change categories (placed by hand)" : "Change categories" },
			});
			setIcon(edit, r.manual ? "hand" : "pencil");
			edit.addEventListener("click", () => new CategoryPickerModal(this.plugin, r).open());
			if (r.matchedKeywords.length && !r.manual) catCell.title = `Matched: ${r.matchedKeywords.join(", ")}`;

			tr.createEl("td", { cls: "ett-from", text: r.from });
			tr.createEl("td", { cls: "ett-subject", text: r.subject ?? "—" });

			const signalCell = tr.createEl("td", { cls: "ett-signal-cell" });
			const many = this.states.size > 1;
			for (const c of contributions.get(r.id) ?? []) {
				const prefix = many ? `${c.task.name}: ` : "";
				if (c.signal) statusBadge(signalCell, c.signal.status, `${prefix}“${c.signal.phrase}”`);
				for (const m of c.milestones) {
					const badge = signalCell.createSpan({ cls: "ett-badge is-milestone" });
					setIcon(badge.createSpan({ cls: "ett-badge-icon" }), "flag");
					badge.createSpan({ text: `${prefix}${m}` });
				}
			}

			const actions = tr.createEl("td", { cls: "ett-row-actions" });
			const act = (icon: string, label: string, onClick: () => void) => {
				const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
				setIcon(b, icon);
				b.addEventListener("click", onClick);
			};
			act("filter", "Create filter from this email", () => new CategoryModal(this.plugin, { fromRecord: r }).open());
			act("search", "Copy search for your mail app", () => {
				const q = r.subject ? `from:${r.from} subject:"${r.subject.replace(/"/g, "")}"` : `from:${r.from}`;
				void navigator.clipboard.writeText(q).then(() => new Notice("Search copied. Paste it into Outlook or Gmail search."));
			});
			if (this.plugin.settings.gmailLinks && r.messageId) {
				const id = r.messageId;
				act("external-link", "Open in Gmail", () => {
					window.open(`https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(id)}`);
				});
			}
			act("trash-2", "Delete record", () =>
				new ConfirmModal(this.app, "Delete this record?", "Only the tracker's reference is removed; your email is untouched.", "Delete", async () => {
					this.plugin.store.remove(r.id);
					await this.plugin.store.save();
				}).open(),
			);
		}

		if (sorted.length > this.limit) {
			const more = card.createEl("button", { cls: "ett-more", text: `Show more (${sorted.length - this.limit} left)` });
			more.addEventListener("click", () => {
				this.limit += PAGE;
				this.render();
			});
		}
	}
}

function earliest(records: EmailRecord[]): Date {
	let min = Date.now();
	for (const r of records) min = Math.min(min, new Date(r.date).getTime());
	return new Date(min);
}

function formatBucket(key: string, g: DateGranularity): string {
	const d = new Date(key + "T00:00:00");
	if (g === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
	return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
