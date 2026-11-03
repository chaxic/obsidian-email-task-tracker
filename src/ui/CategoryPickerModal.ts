import { Modal, Notice, Setting } from "obsidian";
import type EmailTrackerPlugin from "../main";
import type { CategoryPath, EmailRecord } from "../types";
import { allPaths, classify, inputFromRecord } from "../classify/engine";
import { assignPaths } from "../store/records";
import { swatch } from "./charts";

/** Choose by hand where one email sits. Every placement of every category is listed. */
export class CategoryPickerModal extends Modal {
	private chosen: Set<string>;

	constructor(private plugin: EmailTrackerPlugin, private record: EmailRecord) {
		super(plugin.app);
		this.chosen = new Set(record.paths.map((p) => p.join("/")));
	}

	onOpen(): void {
		this.titleEl.setText("Categories for this email");
		const { contentEl } = this;
		contentEl.createDiv({ cls: "ett-muted", text: this.record.subject ?? this.record.from });
		const cats = this.plugin.categories;
		const byId = new Map(cats.map((c) => [c.id, c]));
		const list = contentEl.createDiv({ cls: "ett-picker" });
		const paths = allPaths(cats);
		if (!paths.length) list.createDiv({ cls: "ett-muted", text: "No categories yet." });
		for (const path of paths) {
			const key = path.join("/");
			const cat = byId.get(path[path.length - 1])!;
			const row = list.createEl("label", { cls: "ett-parent-option ett-picker-row" });
			row.setCssProps({ "--ett-depth": String(path.length - 1) });
			const box = row.createEl("input", { type: "checkbox" });
			box.checked = this.chosen.has(key);
			box.addEventListener("change", () => (box.checked ? this.chosen.add(key) : this.chosen.delete(key)));
			swatch(row, cat.color);
			row.createSpan({ text: cat.name });
		}
		contentEl.createDiv({
			cls: "ett-muted",
			text: "Choosing by hand stops filters from moving this email. Use “Back to automatic” to undo that.",
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Back to automatic").onClick(() => void this.automatic()))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => void this.save()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async save(): Promise<void> {
		const paths: CategoryPath[] = [...this.chosen].map((k) => k.split("/"));
		assignPaths(this.record, paths);
		this.record.manual = true;
		this.record.matchedKeywords = [];
		await this.plugin.store.save();
		this.close();
	}

	private async automatic(): Promise<void> {
		const result = classify(this.plugin.categories, inputFromRecord(this.record));
		this.record.manual = false;
		assignPaths(this.record, result.paths);
		this.record.matchedKeywords = result.matchedKeywords;
		await this.plugin.store.save();
		new Notice(result.paths.length ? "Filters re-applied to this email." : "No filter matches this email; it's now Uncategorized.");
		this.close();
	}
}
