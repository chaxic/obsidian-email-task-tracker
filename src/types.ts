export type TaskStatus = "open" | "waiting" | "done";
export type DateGranularity = "day" | "week" | "month";
export type MatchField = "subject" | "body" | "from";

export interface Rule {
	/** Match if at least one of these appears. */
	anyOf: string[];
	/** Match only if every one of these appears. */
	allOf: string[];
	/** Never match if any of these appears. */
	noneOf: string[];
	/** Exact sender addresses, e.g. someone@example.com */
	senders: string[];
	/** Sender domains; subdomains match too, e.g. example.com matches mail.example.com */
	domains: string[];
	/** Which parts of the email the keyword lists are checked against. */
	fields: MatchField[];
}

export interface Category {
	id: string;
	name: string;
	/** Empty = top level. Several = a shared child category (e.g. Unity under Gaming and Software). */
	parentIds: string[];
	color: string;
	rule: Rule;
	/** The category is a task: its emails (and its child categories' emails) are the task's activity. */
	trackAsTask: boolean;
	dateGranularity: DateGranularity;
	/** Phrases that move the task's status when a newer email contains them. */
	statusRules: StatusRules;
	/** Ordered progress steps, each reached when an email first contains the phrase. */
	milestones: string[];
	due?: string;
	/** Status you set by hand; holds until a newer email changes it. */
	override?: { status: TaskStatus; at: string };
}

export interface StatusRules {
	done: string[];
	waiting: string[];
	/** Reopen phrases, e.g. "not resolved". */
	open: string[];
}

export const DEFAULT_STATUS_RULES: StatusRules = {
	done: ["resolved", "completed", "closed"],
	waiting: ["waiting for", "waiting on", "pending", "on hold"],
	open: ["reopened", "not resolved", "still not working", "still an issue"],
};

/** A chain of category ids from a top-level category down to a matched one. */
export type CategoryPath = string[];

/**
 * Everything the plugin keeps about an email. The body, HTML, recipients and
 * attachments are deliberately absent: they exist only in memory during import.
 */
export interface EmailRecord {
	id: string;
	/** Hash of Message-ID (or sender+subject+date); used to skip duplicates. */
	fingerprint: string;
	messageId: string | null;
	subject: string | null;
	from: string;
	fromDomain: string;
	/** ISO timestamp of when the email was sent (falls back to import time). */
	date: string;
	importedAt: string;
	source: "eml" | "msg";
	/** Where the email sits; empty = Uncategorized. Only the longest chains are kept. */
	paths: CategoryPath[];
	/** True when you assigned categories by hand; re-runs leave it alone. */
	manual: boolean;
	matchedKeywords: string[];
	/** Top terms from subject and body, kept so filters can be re-run later. */
	keywords: string[];
	/** Task status and milestone phrases found in this email (quoted replies ignored). */
	statusPhrases: string[];
}

export type PanelType = "activity" | "share" | "matrix" | "weekhour" | "calendar" | "senders" | "status";

export const PANEL_TYPE_IDS: PanelType[] = ["activity", "share", "matrix", "weekhour", "calendar", "senders", "status"];

export interface PanelConfig {
	id: string;
	type: PanelType;
	/** Variant within the type, e.g. "stacked" | "grouped" | "lines" for activity. */
	style?: string;
	width: "half" | "full";
}

/**
 * Non-sensitive preferences, saved in data.json. Categories and records live in
 * records.json, which is the file that gets encrypted.
 */
export interface TrackerSettings {
	storeSubject: boolean;
	keywordCount: number;
	gmailLinks: boolean;
	/** Folder outside the vault to watch for .eml/.msg files; empty = off. */
	dropFolder: string;
	deleteAfterImport: boolean;
	/** Show what a drop contained (file names, types, sizes; never content). */
	dropDiagnostics: boolean;
	dashboardPanels: PanelConfig[];
	/** Minutes of inactivity before an encrypted store locks itself; 0 = never. */
	autoLockMinutes: number;
	/**
	 * True while encryption is on. If records.json later turns up unencrypted or missing,
	 * this is how the plugin notices and warns instead of silently saving plain text.
	 */
	encryptionExpected: boolean;
}

export const DEFAULT_PANELS: PanelConfig[] = [
	{ id: "p-activity", type: "activity", style: "stacked", width: "full" },
	{ id: "p-share", type: "share", style: "bars", width: "half" },
	{ id: "p-weekhour", type: "weekhour", width: "half" },
];

export const DEFAULT_SETTINGS: TrackerSettings = {
	storeSubject: true,
	keywordCount: 15,
	gmailLinks: false,
	dropFolder: "",
	deleteAfterImport: false,
	dropDiagnostics: false,
	dashboardPanels: DEFAULT_PANELS,
	autoLockMinutes: 30,
	encryptionExpected: false,
};

export function emptyRule(): Rule {
	return { anyOf: [], allOf: [], noneOf: [], senders: [], domains: [], fields: ["subject", "body"] };
}
