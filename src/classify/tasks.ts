import { DEFAULT_STATUS_RULES, type Category, type EmailRecord, type StatusRules, type TaskStatus } from "../types";
import { containsTerm, unique } from "./rules";
import { inCategory } from "./engine";
import { stripQuoted } from "../ingest/text";

const MAX_STORED_PHRASES = 20;

export interface TaskSignal {
	status: TaskStatus;
	phrase: string;
}

export interface TaskState {
	status: TaskStatus;
	/** auto = set by an email; manual = set by you; default = no signal yet. */
	source: "auto" | "manual" | "default";
	emailCount: number;
	opened: Date | null;
	lastActivity: Date | null;
	/** The email signal currently deciding the status (when source is auto). */
	lastSignal: (TaskSignal & { at: Date; record: EmailRecord }) | null;
	history: { status: TaskStatus; at: Date; phrase?: string; manual?: boolean }[];
	milestones: { phrase: string; reachedAt: Date | null }[];
	/** Emails oldest first, with what each one contributed. */
	events: { record: EmailRecord; signal: TaskSignal | null; milestones: string[] }[];
}

export function rulesOf(cat: Category): StatusRules {
	return cat.statusRules ?? DEFAULT_STATUS_RULES;
}

/** Every phrase worth looking for at import: all task rules and milestones, plus the defaults. */
export function allTaskPhrases(categories: Category[]): string[] {
	const out: string[] = [...DEFAULT_STATUS_RULES.done, ...DEFAULT_STATUS_RULES.waiting, ...DEFAULT_STATUS_RULES.open];
	for (const c of categories) {
		if (!c.trackAsTask) continue;
		const r = rulesOf(c);
		out.push(...r.done, ...r.waiting, ...r.open, ...(c.milestones ?? []));
	}
	return unique(out.map((p) => p.trim().toLowerCase()).filter(Boolean));
}

/** Phrases present in the new part of an email (quoted history removed). */
export function detectPhrases(subject: string, body: string, phrases: string[]): string[] {
	const text = `${subject}\n${stripQuoted(body)}`;
	return phrases.filter((p) => containsTerm(text, p)).slice(0, MAX_STORED_PHRASES);
}

/** Does a stored record contain this phrase? Checks phrases found at import, then stored text. */
function recordHas(record: EmailRecord, phrase: string, storedText: string): boolean {
	const p = phrase.trim().toLowerCase();
	return !!p && ((record.statusPhrases ?? []).includes(p) || containsTerm(storedText, p));
}

function storedText(r: EmailRecord): string {
	return [r.subject ?? "", ...r.keywords, ...r.matchedKeywords].join("\n");
}

const TIE_ORDER: TaskStatus[] = ["open", "waiting", "done"];

/**
 * The status an email signals for a task. The longest matching phrase wins, so
 * "not resolved" beats "resolved"; on a tie Open beats Waiting beats Done, so a
 * task never closes by accident.
 */
export function signalFor(record: EmailRecord, rules: StatusRules): TaskSignal | null {
	const text = storedText(record);
	let best: TaskSignal | null = null;
	for (const status of TIE_ORDER) {
		for (const phrase of rules[status]) {
			if (!recordHas(record, phrase, text)) continue;
			if (!best || phrase.length > best.phrase.length) best = { status, phrase: phrase.trim().toLowerCase() };
		}
	}
	return best;
}

export function taskState(cat: Category, records: EmailRecord[]): TaskState {
	const rules = rulesOf(cat);
	const mine = records
		.filter((r) => inCategory(r, cat.id))
		.sort((a, b) => a.date.localeCompare(b.date));
	const milestones = (cat.milestones ?? []).map((phrase) => ({ phrase, reachedAt: null as Date | null }));

	let status: TaskStatus = "open";
	let lastSignal: TaskState["lastSignal"] = null;
	const history: TaskState["history"] = [];
	const events: TaskState["events"] = [];

	for (const r of mine) {
		const at = new Date(r.date);
		const text = storedText(r);
		const signal = signalFor(r, rules);
		const reached: string[] = [];
		for (const m of milestones) {
			if (!m.reachedAt && recordHas(r, m.phrase, text)) {
				m.reachedAt = at;
				reached.push(m.phrase);
			}
		}
		if (signal) {
			lastSignal = { ...signal, at, record: r };
			if (signal.status !== status) history.push({ status: signal.status, at, phrase: signal.phrase });
			status = signal.status;
		}
		events.push({ record: r, signal, milestones: reached });
	}

	let source: TaskState["source"] = lastSignal ? "auto" : "default";
	if (cat.override) {
		const overrideAt = new Date(cat.override.at);
		// A newer email signal takes over again; until then your choice holds.
		if (!lastSignal || lastSignal.at <= overrideAt) {
			history.push({ status: cat.override.status, at: overrideAt, manual: true });
			history.sort((a, b) => a.at.getTime() - b.at.getTime());
			status = cat.override.status;
			source = "manual";
		}
	}

	return {
		status,
		source,
		emailCount: mine.length,
		opened: mine.length ? new Date(mine[0].date) : null,
		lastActivity: mine.length ? new Date(mine[mine.length - 1].date) : null,
		lastSignal: source === "auto" ? lastSignal : null,
		history,
		milestones,
		events,
	};
}

/** The tasks a record belongs to. */
export function tasksOf(categories: Category[], record: EmailRecord): Category[] {
	return categories.filter((c) => c.trackAsTask && inCategory(record, c.id));
}
