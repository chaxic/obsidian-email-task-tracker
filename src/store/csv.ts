import type { Category, EmailRecord } from "../types";
import { recordLabel } from "../classify/engine";
import { signalFor, rulesOf, taskState, tasksOf } from "../classify/tasks";

const COLUMNS = ["date", "category", "from", "subject", "signal", "task_status", "matched_keywords", "message_id"];

export function toCsv(records: EmailRecord[], categories: Category[]): string {
	const states = new Map(categories.filter((c) => c.trackAsTask).map((c) => [c.id, taskState(c, records)]));
	const rows = records.map((r) => [
		r.date,
		recordLabel(categories, r),
		r.from,
		r.subject ?? "",
		tasksOf(categories, r)
			.map((t) => {
				const sig = signalFor(r, rulesOf(t));
				return sig ? `${t.name}: ${sig.status} (${sig.phrase})` : "";
			})
			.filter(Boolean)
			.join("; "),
		tasksOf(categories, r)
			.map((t) => `${t.name}: ${states.get(t.id)?.status ?? ""}`)
			.join("; "),
		r.matchedKeywords.join("; "),
		r.messageId ?? "",
	]);
	return [COLUMNS, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

function cell(value: string): string {
	// Prefix formula-looking values so spreadsheet apps don't execute them.
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
