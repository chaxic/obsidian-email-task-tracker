import { setIcon } from "obsidian";
import type { Category, TaskStatus } from "../types";

export const TASK_ICON = "clipboard-check";

export const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", waiting: "Waiting", done: "Done" };

/** Small clipboard icon marking a category that is tracked as a task. */
export function taskIcon(parent: HTMLElement, cat?: Category): HTMLElement | null {
	if (cat && !cat.trackAsTask) return null;
	const el = parent.createSpan({ cls: "ett-task-icon", attr: { "aria-label": "Task" } });
	setIcon(el, TASK_ICON);
	return el;
}

/** Status pill: colour always comes with its label. */
export function statusBadge(parent: HTMLElement, status: TaskStatus, detail?: string): HTMLElement {
	const el = parent.createSpan({ cls: `ett-badge is-${status}` });
	el.createSpan({ cls: "ett-badge-dot" });
	el.createSpan({ text: detail ? `${STATUS_LABEL[status]} · ${detail}` : STATUS_LABEL[status] });
	return el;
}
