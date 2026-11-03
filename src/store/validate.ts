/**
 * Checks for data read from disk. data.json and records.json can be edited by
 * hand, replaced by a sync conflict or written by another version of the plugin,
 * so nothing read from them is trusted as-is. Colours matter most: they end up
 * in CSS and SVG, where anything but a plain hex value could load a remote resource.
 */
import {
	DEFAULT_PANELS,
	DEFAULT_SETTINGS,
	DEFAULT_STATUS_RULES,
	PANEL_TYPE_IDS,
	emptyRule,
	type Category,
	type CategoryPath,
	type DateGranularity,
	type EmailRecord,
	type MatchField,
	type PanelConfig,
	type PanelType,
	type Rule,
	type StatusRules,
	type TaskStatus,
	type TrackerSettings,
} from "../types";
import { OTHER_COLOR } from "../ui/charts";

const MATCH_FIELDS: MatchField[] = ["subject", "body", "from"];
const GRANULARITIES: DateGranularity[] = ["day", "week", "month"];
const STATUSES: TaskStatus[] = ["open", "waiting", "done"];

export function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stringList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function isHexColor(v: unknown): v is string {
	return typeof v === "string" && /^#(?:[0-9a-f]{3}){1,2}$/i.test(v);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
/** Ids are joined with "/" to key paths, so they can't contain one. */
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("/");

function normalizeRule(v: unknown): Rule {
	const r = isObject(v) ? v : {};
	return {
		anyOf: stringList(r.anyOf),
		allOf: stringList(r.allOf),
		noneOf: stringList(r.noneOf),
		senders: stringList(r.senders),
		domains: stringList(r.domains),
		fields: Array.isArray(r.fields)
			? stringList(r.fields).filter((f): f is MatchField => MATCH_FIELDS.includes(f as MatchField))
			: emptyRule().fields,
	};
}

function normalizeStatusRules(v: unknown): StatusRules {
	if (!isObject(v)) return structuredClone(DEFAULT_STATUS_RULES);
	return { done: stringList(v.done), waiting: stringList(v.waiting), open: stringList(v.open) };
}

function normalizeCategory(v: unknown): Category | null {
	if (!isObject(v) || !isId(v.id) || typeof v.name !== "string" || !v.name) return null;
	const g = v.dateGranularity as DateGranularity;
	const cat: Category = {
		id: v.id,
		name: v.name,
		parentIds: stringList(v.parentIds),
		color: isHexColor(v.color) ? v.color : OTHER_COLOR,
		rule: normalizeRule(v.rule),
		trackAsTask: v.trackAsTask === true,
		dateGranularity: GRANULARITIES.includes(g) ? g : "week",
		statusRules: normalizeStatusRules(v.statusRules),
		milestones: stringList(v.milestones),
	};
	const due = str(v.due);
	if (due) cat.due = due;
	const o = v.override;
	if (isObject(o) && STATUSES.includes(o.status as TaskStatus) && typeof o.at === "string") {
		cat.override = { status: o.status as TaskStatus, at: o.at };
	}
	return cat;
}

/** Well-formed categories only, without duplicate ids or links to parents that don't exist. */
export function normalizeCategories(raw: unknown[]): Category[] {
	const out: Category[] = [];
	const seen = new Set<string>();
	for (const c of raw.map(normalizeCategory)) {
		if (c && !seen.has(c.id)) {
			seen.add(c.id);
			out.push(c);
		}
	}
	for (const c of out) c.parentIds = [...new Set(c.parentIds)].filter((p) => p !== c.id && seen.has(p));
	return out;
}

function normalizeRecord(v: unknown): EmailRecord | null {
	if (!isObject(v) || !isId(v.id) || typeof v.date !== "string" || isNaN(Date.parse(v.date))) return null;
	const from = str(v.from) ?? "";
	const paths: CategoryPath[] = Array.isArray(v.paths)
		? v.paths.filter((p): p is string[] => Array.isArray(p) && p.length > 0 && p.every(isId))
		: [];
	return {
		id: v.id,
		fingerprint: str(v.fingerprint) ?? "",
		messageId: str(v.messageId),
		subject: str(v.subject),
		from,
		fromDomain: str(v.fromDomain) ?? from.slice(from.lastIndexOf("@") + 1).toLowerCase(),
		date: v.date,
		importedAt: str(v.importedAt) ?? v.date,
		source: v.source === "msg" ? "msg" : "eml",
		paths,
		manual: v.manual === true,
		matchedKeywords: stringList(v.matchedKeywords),
		keywords: stringList(v.keywords),
		statusPhrases: stringList(v.statusPhrases),
	};
}

/** Records that can be read, with missing or wrongly typed fields repaired. Ones with no id or date are dropped. */
export function normalizeRecords(raw: unknown[]): EmailRecord[] {
	return raw.map(normalizeRecord).filter((r): r is EmailRecord => r !== null);
}

function normalizePanels(v: unknown): PanelConfig[] {
	if (!Array.isArray(v)) return structuredClone(DEFAULT_PANELS);
	const out: PanelConfig[] = [];
	for (const p of v) {
		if (!isObject(p) || typeof p.id !== "string" || !PANEL_TYPE_IDS.includes(p.type as PanelType)) continue;
		const panel: PanelConfig = { id: p.id, type: p.type as PanelType, width: p.width === "full" ? "full" : "half" };
		if (typeof p.style === "string") panel.style = p.style;
		out.push(panel);
	}
	return out;
}

/** Settings as loaded from data.json, with anything malformed replaced by its default. Unknown keys are dropped. */
export function normalizeSettings(raw: unknown): TrackerSettings {
	const d = isObject(raw) ? raw : {};
	const num = (v: unknown, fallback: number, max: number) =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : fallback;
	return {
		storeSubject: bool(d.storeSubject, DEFAULT_SETTINGS.storeSubject),
		keywordCount: num(d.keywordCount, DEFAULT_SETTINGS.keywordCount, 50),
		gmailLinks: bool(d.gmailLinks, DEFAULT_SETTINGS.gmailLinks),
		dropFolder: str(d.dropFolder) ?? DEFAULT_SETTINGS.dropFolder,
		deleteAfterImport: bool(d.deleteAfterImport, DEFAULT_SETTINGS.deleteAfterImport),
		dropDiagnostics: bool(d.dropDiagnostics, DEFAULT_SETTINGS.dropDiagnostics),
		dashboardPanels: normalizePanels(d.dashboardPanels),
		autoLockMinutes: num(d.autoLockMinutes, DEFAULT_SETTINGS.autoLockMinutes, 24 * 60),
		encryptionExpected: bool(d.encryptionExpected, DEFAULT_SETTINGS.encryptionExpected),
	};
}
