import { Menu, Notice } from "obsidian";
import type EmailTrackerPlugin from "../main";
import type { Category } from "../types";
import { CategoryModal } from "./CategoryModal";
import { ConfirmModal } from "./ConfirmModal";

export function confirmDeleteCategory(plugin: EmailTrackerPlugin, cat: Category, after?: () => void): void {
	new ConfirmModal(
		plugin.app,
		`Delete "${cat.name}"?`,
		"Its child categories move up to take its place, and emails stay tracked. Your other categories are unchanged.",
		"Delete",
		async () => {
			await plugin.deleteCategory(cat.id);
			new Notice(`Deleted "${cat.name}".`);
			after?.();
		},
	).open();
}

/**
 * Right-click menu for a category shown in a tree.
 * `parentId` is the parent it's displayed under (null at the top level).
 */
export function openCategoryMenu(evt: MouseEvent, plugin: EmailTrackerPlugin, cat: Category, parentId: string | null): void {
	const menu = new Menu();
	menu.addItem((i) => i.setTitle("Edit").setIcon("pencil").onClick(() => new CategoryModal(plugin, { category: cat }).open()));
	menu.addItem((i) =>
		i.setTitle("Add child category").setIcon("plus").onClick(() => new CategoryModal(plugin, { parentId: cat.id }).open()),
	);
	if (parentId) {
		const parent = plugin.categories.find((c) => c.id === parentId);
		const only = cat.parentIds.length === 1;
		menu.addItem((i) =>
			i
				.setTitle(only ? "Move to top level" : `Remove from "${parent?.name ?? "parent"}"`)
				.setIcon("unlink")
				.onClick(() => void plugin.removeFromParent(cat.id, parentId)),
		);
	}
	menu.addSeparator();
	menu.addItem((i) => i.setTitle("Delete").setIcon("trash-2").onClick(() => confirmDeleteCategory(plugin, cat)));
	menu.showAtMouseEvent(evt);
}
