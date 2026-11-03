import { Modal, Notice, Setting, type TextAreaComponent } from "obsidian";
import type EmailTrackerPlugin from "../main";
import { DEFAULT_STATUS_RULES, emptyRule, type Category, type EmailRecord, type MatchField } from "../types";
import {
	applyRelationships,
	categoryDisplayName,
	childrenOf,
	classify,
	findNameClash,
	hasCycle,
	inCategory,
	inputFromRecord,
	sortedByDisplayName,
	subtreeIds,
} from "../classify/engine";
import { hasConditions, unique } from "../classify/rules";
import { tokenize } from "../ingest/keywords";
import { CATEGORY_COLORS, OTHER_COLOR, swatch } from "./charts";
import { confirmDeleteCategory } from "./categoryActions";
import { taskIcon } from "./icons";

type ListKey = "anyOf" | "allOf" | "noneOf" | "senders" | "domains";

export function newCategory(categories: Category[], parentIds: string[]): Category {
	const siblings = childrenOf(categories, parentIds[0] ?? null);
	return {
		id: crypto.randomUUID(),
		name: "",
		parentIds,
		color: CATEGORY_COLORS[siblings.length] ?? OTHER_COLOR,
		rule: emptyRule(),
		trackAsTask: false,
		dateGranularity: "week",
		statusRules: structuredClone(DEFAULT_STATUS_RULES),
		milestones: [],
	};
}

function parseList(value: string): string[] {
	return unique(
		value
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

export interface CategoryModalOptions {
	/** Edit this category. */
	category?: Category;
	/** Create a new category under this parent. */
	parentId?: string | null;
	/** Build a filter from this email: shows suggestion chips and a target picker. */
	fromRecord?: EmailRecord;
}

export class CategoryModal extends Modal {
	private draft!: Category;
	private isNew = true;
	/** Categories that will sit directly under this one. */
	private childIds = new Set<string>();
	/** New categories typed into the Relationships section, created on Save. */
	private pending: Category[] = [];
	private lists = new Map<ListKey, TextAreaComponent>();
	private previewEl!: HTMLElement;
	private formEl!: HTMLElement;
	private relEl!: HTMLElement;
	private taskEl!: HTMLElement;

	constructor(private plugin: EmailTrackerPlugin, private opts: CategoryModalOptions = {}) {
		super(plugin.app);
		this.startFrom(opts.category, opts.parentId ? [opts.parentId] : []);
	}

	private startFrom(existing: Category | undefined, parentIds: string[] = []): void {
		this.isNew = !existing;
		this.draft = existing ? structuredClone(existing) : newCategory(this.plugin.categories, parentIds);
		this.childIds = new Set(existing ? childrenOf(this.plugin.categories, existing.id).map((c) => c.id) : []);
		this.pending = [];
	}

	/** All categories as they will be after Save. */
	private working(): Category[] {
		const base = [...this.plugin.categories.filter((c) => c.id !== this.draft.id), this.draft, ...this.pending];
		return applyRelationships(base, this.draft.id, this.draft.parentIds, [...this.childIds]);
	}

	onOpen(): void {
		this.modalEl.addClass("ett-modal");
		this.titleEl.setText(this.opts.fromRecord ? "Create filter from email" : this.isNew ? "New category" : "Edit category");
		if (this.opts.fromRecord) this.renderSource(this.opts.fromRecord);
		this.formEl = this.contentEl.createDiv();
		this.renderForm();
		this.previewEl = this.contentEl.createDiv({ cls: "ett-preview" });
		this.renderButtons();
		this.updatePreview();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderSource(record: EmailRecord): void {
		const box = this.contentEl.createDiv({ cls: "ett-source" });
		box.createDiv({ cls: "ett-source-subject", text: record.subject ?? "(subject not stored)" });
		box.createDiv({ cls: "ett-muted", text: `${record.from} · ${new Date(record.date).toLocaleString()}` });

		new Setting(box)
			.setName("Add to")
			.setDesc("Start a new category, or add these keywords to an existing one.")
			.addDropdown((dd) => {
				dd.addOption("", "New category");
				for (const c of sortedByDisplayName(this.plugin.categories)) dd.addOption(c.id, categoryDisplayName(this.plugin.categories, c.id));
				dd.onChange((id) => {
					this.startFrom(this.plugin.categories.find((c) => c.id === id));
					chips.querySelectorAll(".is-added").forEach((el) => el.removeClass("is-added"));
					this.renderForm();
					this.updatePreview();
				});
			});

		box.createDiv({ cls: "ett-muted", text: "Click a suggestion to add it to the filter." });
		const chips = box.createDiv({ cls: "ett-chips" });
		const addChip = (label: string, key: ListKey, value: string) => {
			const chip = chips.createEl("button", { cls: "ett-chip", text: label });
			chip.addEventListener("click", () => {
				const current = this.draft.rule[key];
				if (!current.includes(value)) this.draft.rule[key] = [...current, value];
				this.lists.get(key)?.setValue(this.draft.rule[key].join(", "));
				chip.addClass("is-added");
				this.updatePreview();
			});
		};
		addChip(`from: ${record.from}`, "senders", record.from);
		addChip(`domain: ${record.fromDomain}`, "domains", record.fromDomain);
		const words = unique([...tokenize(record.subject ?? ""), ...record.keywords]);
		for (const w of words.slice(0, 30)) addChip(w, "anyOf", w);
	}

	private renderForm(): void {
		const el = this.formEl;
		el.empty();
		this.lists.clear();
		const d = this.draft;

		new Setting(el).setName("Name").addText((t) =>
			t
				.setPlaceholder("Invoices")
				.setValue(d.name)
				.onChange((v) => (d.name = v.trim())),
		);

		el.createEl("h4", { text: "Relationships" });
		el.createDiv({
			cls: "ett-muted",
			text:
				"Tick existing categories, or type a name to create a new one. A category can have several parents, " +
				"e.g. Unity under both Gaming and Software.",
		});
		this.relEl = el.createDiv({ cls: "ett-rel" });
		this.renderRelationships();

		new Setting(el).setName("Colour").addColorPicker((c) => c.setValue(d.color).onChange((v) => (d.color = v)));

		const taskToggle = new Setting(el)
			.setName("Treat as a task")
			.setDesc(
				"This category becomes one task. Its emails, and its child categories' emails, are the task's activity, " +
					"and its status (Open, Waiting, Done) follows what the newest emails say.",
			)
			.addToggle((t) =>
				t.setValue(d.trackAsTask).onChange((v) => {
					d.trackAsTask = v;
					this.renderTaskSection();
				}),
			);
		taskIcon(taskToggle.nameEl);
		this.taskEl = el.createDiv({ cls: "ett-task-section" });
		this.renderTaskSection();

		new Setting(el).setName("Chart by").addDropdown((dd) =>
			dd
				.addOptions({ day: "Day", week: "Week", month: "Month" })
				.setValue(d.dateGranularity)
				.onChange((v) => (d.dateGranularity = v as Category["dateGranularity"])),
		);

		el.createEl("h4", { text: "Filter" });
		el.createDiv({
			cls: "ett-muted",
			text:
				"Separate entries with commas; phrases are allowed. Every section you fill in must match. " +
				"Leave the filter empty to use this category as a group that only collects its child categories. " +
				"If you do fill it in, emails must also match it to count in its child categories.",
		});
		this.listSetting(el, "anyOf", "Contains any of", "invoice, receipt, payment due");
		this.listSetting(el, "allOf", "Contains all of", "order, shipped");
		this.listSetting(el, "noneOf", "Never if it contains", "newsletter, unsubscribe");
		this.listSetting(el, "senders", "From these addresses", "someone@example.com");
		this.listSetting(el, "domains", "From these domains", "example.com");

		const fields = new Setting(el).setName("Look for keywords in");
		for (const [field, label] of [["subject", "Subject"], ["body", "Body"], ["from", "Sender name"]] as [MatchField, string][]) {
			fields.addToggle((t) => {
				t.setTooltip(label)
					.setValue(d.rule.fields.includes(field))
					.onChange((on) => {
						d.rule.fields = on ? unique([...d.rule.fields, field]) : d.rule.fields.filter((f) => f !== field);
						this.updatePreview();
					});
				t.toggleEl.parentElement?.createSpan({ cls: "ett-toggle-label", text: label });
			});
		}
	}

	/** Status phrases, milestones and due date; only shown for tasks. */
	private renderTaskSection(): void {
		const el = this.taskEl;
		if (!el) return;
		el.empty();
		const d = this.draft;
		if (!d.trackAsTask) return;
		d.statusRules ??= structuredClone(DEFAULT_STATUS_RULES);
		d.milestones ??= [];
		el.createDiv({
			cls: "ett-muted",
			text:
				"Status follows the newest email containing one of these phrases (quoted replies are ignored). " +
				"The longest phrase wins, so “not resolved” beats “resolved”. Separate phrases with commas.",
		});
		const rules = d.statusRules;
		const area = (name: string, desc: string, value: string[], placeholder: string, set: (v: string[]) => void) =>
			new Setting(el)
				.setName(name)
				.setDesc(desc)
				.addTextArea((ta) => {
					ta.setPlaceholder(placeholder)
						.setValue(value.join(", "))
						.onChange((v) => set(parseList(v)));
					ta.inputEl.rows = 2;
				});
		area("Mark Done when an email says", "", rules.done, DEFAULT_STATUS_RULES.done.join(", "), (v) => (rules.done = v));
		area("Mark Waiting when an email says", "", rules.waiting, DEFAULT_STATUS_RULES.waiting.join(", "), (v) => (rules.waiting = v));
		area("Reopen when an email says", "", rules.open, DEFAULT_STATUS_RULES.open.join(", "), (v) => (rules.open = v));
		area(
			"Milestones",
			"Steps in order. Each is ticked off, with its date, the first time an email mentions it.",
			d.milestones,
			"approved, ordered, delivered",
			(v) => (d.milestones = v),
		);
		new Setting(el).setName("Due date").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(d.due ?? "").onChange((v) => (d.due = v || undefined));
		});
		el.createDiv({
			cls: "ett-muted",
			text: "New phrases apply fully to emails imported from now on. Past emails are checked against their stored subject and keywords.",
		});
	}

	/** Parents and child categories, side by side. Options that would create a loop are disabled. */
	private renderRelationships(): void {
		const el = this.relEl;
		if (!el) return;
		el.empty();
		const d = this.draft;
		const w = this.working();
		const below = subtreeIds(w, d.id);
		const others = sortedByDisplayName(w).filter((c) => c.id !== d.id);
		const pendingIds = new Set(this.pending.map((p) => p.id));

		const column = (
			title: string,
			isChecked: (c: Category) => boolean,
			loops: (c: Category) => boolean,
			toggle: (c: Category, on: boolean) => void,
			placeholder: string,
			create: (name: string) => void,
		) => {
			const col = el.createDiv({ cls: "ett-rel-col" });
			col.createDiv({ cls: "ett-rel-title", text: title });
			const list = col.createDiv({ cls: "ett-parent-list" });
			if (!others.length) list.createDiv({ cls: "ett-muted", text: "No other categories yet." });
			for (const c of others) {
				const checked = isChecked(c);
				const disabled = !checked && loops(c);
				const row = list.createEl("label", { cls: "ett-parent-option" + (disabled ? " is-disabled" : "") });
				const box = row.createEl("input", { type: "checkbox" });
				box.checked = checked;
				box.disabled = disabled;
				if (disabled) row.title = "Would create a loop";
				box.addEventListener("change", () => {
					toggle(c, box.checked);
					this.renderRelationships();
					this.updatePreview();
				});
				swatch(row, c.color);
				row.createSpan({ text: categoryDisplayName(w, c.id) });
				taskIcon(row, c);
				if (pendingIds.has(c.id)) row.createSpan({ cls: "ett-new-tag", text: "new" });
			}
			const add = col.createDiv({ cls: "ett-rel-new" });
			const input = add.createEl("input", { type: "text", placeholder });
			const button = add.createEl("button", { text: "Add" });
			const go = () => {
				const name = input.value.trim();
				if (!name) return;
				create(name);
				this.renderRelationships();
				this.updatePreview();
			};
			button.addEventListener("click", go);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					go();
				}
			});
		};

		column(
			"Parent categories",
			(c) => d.parentIds.includes(c.id),
			(c) => below.has(c.id) || this.childIds.has(c.id),
			(c, on) => {
				if (on) d.parentIds = unique([...d.parentIds, c.id]);
				else {
					d.parentIds = d.parentIds.filter((p) => p !== c.id);
					this.dropPending(c.id);
				}
			},
			"New parent category",
			(name) => {
				const cat = { ...newCategory(this.working(), []), name };
				this.pending.push(cat);
				d.parentIds = unique([...d.parentIds, cat.id]);
			},
		);
		column(
			"Child categories",
			(c) => this.childIds.has(c.id),
			(c) => subtreeIds(w, c.id).has(d.id) || d.parentIds.includes(c.id),
			(c, on) => {
				if (on) this.childIds.add(c.id);
				else {
					this.childIds.delete(c.id);
					this.dropPending(c.id);
				}
			},
			"New child category",
			(name) => {
				const cat = { ...newCategory(this.working(), [d.id]), name, parentIds: [] };
				this.pending.push(cat);
				this.childIds.add(cat.id);
			},
		);
	}

	/** Unticking a category typed in this dialog discards it. */
	private dropPending(id: string): void {
		this.pending = this.pending.filter((p) => p.id !== id);
	}

	private listSetting(el: HTMLElement, key: ListKey, name: string, placeholder: string): void {
		new Setting(el).setName(name).addTextArea((ta) => {
			this.lists.set(key, ta);
			ta.setPlaceholder(placeholder)
				.setValue(this.draft.rule[key].join(", "))
				.onChange((v) => {
					this.draft.rule[key] = parseList(v);
					this.updatePreview();
				});
			ta.inputEl.rows = 2;
		});
	}

	private updatePreview(): void {
		if (!this.previewEl) return;
		const el = this.previewEl;
		el.empty();
		const cats = this.working();
		const pool = this.plugin.store.records.filter((r) => r.paths.length === 0 && !r.manual);
		const hits = pool.filter((r) => classify(cats, inputFromRecord(r)).paths.some((p) => p.includes(this.draft.id)));
		const hasChildren = childrenOf(cats, this.draft.id).length > 0;
		const title = hasConditions(this.draft.rule)
			? `Would sort ${hits.length} of ${pool.length} uncategorized email${pool.length === 1 ? "" : "s"} here`
			: hasChildren
				? "No filter: this category groups its child categories."
				: "Add a keyword, address or domain, or give this category child categories.";
		el.createDiv({ cls: "ett-preview-title", text: title });
		const list = el.createEl("ul");
		for (const r of hits.slice(0, 8)) list.createEl("li", { text: `${r.subject ?? "(no subject stored)"} — ${r.from}` });
		if (hits.length > 8) list.createEl("li", { cls: "ett-muted", text: `…and ${hits.length - 8} more` });
		el.createDiv({
			cls: "ett-muted",
			text: "Past emails are matched on their stored subject, sender and keywords. New imports use the full email.",
		});
	}

	private renderButtons(): void {
		const row = new Setting(this.contentEl);
		if (!this.isNew && !this.opts.fromRecord) {
			row.addButton((b) =>
				b
					.setButtonText("Delete")
					.setWarning()
					.onClick(() => confirmDeleteCategory(this.plugin, this.draft, () => this.close())),
			);
		}
		row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		row.addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(() => void this.save()),
		);
	}

	private async save(): Promise<void> {
		const d = this.draft;
		if (!d.name) {
			new Notice("Give the category a name.");
			return;
		}
		const next = this.working();
		if (hasCycle(next)) {
			new Notice("These choices would put a category inside itself. Untick one of them.");
			return;
		}
		const clash = findNameClash(next, [d.id, ...this.pending.map((p) => p.id)]);
		if (clash) {
			new Notice(`"${clash[0].name}" would sit next to an existing "${clash[1].name}". Pick a different name.`);
			return;
		}
		const created = this.pending.length;
		const moved = await this.plugin.saveCategories(next);
		const parts = [`Saved "${d.name}".`];
		if (created) parts.push(`Created ${created} new categor${created === 1 ? "y" : "ies"}.`);
		if (moved) parts.push(`Re-sorted ${moved} email${moved === 1 ? "" : "s"}.`);
		const src = this.opts.fromRecord && this.plugin.store.get(this.opts.fromRecord.id);
		if (src && !inCategory(src, d.id)) parts.push("This email still doesn't match; you can assign it by hand on the dashboard.");
		new Notice(parts.join(" "));
		this.close();
	}
}
