import { describe, expect, it } from "vitest";
import { allTaskPhrases, detectPhrases, signalFor, taskState } from "../src/classify/tasks";
import { stripQuoted } from "../src/ingest/text";
import { migrate } from "../src/store/records";
import { DEFAULT_STATUS_RULES, emptyRule, type Category, type EmailRecord } from "../src/types";

function task(extra: Partial<Category> = {}): Category {
	return {
		id: "t",
		name: "Office move",
		parentIds: [],
		color: "#888",
		rule: { ...emptyRule(), anyOf: ["office move"] },
		trackAsTask: true,
		dateGranularity: "week",
		statusRules: structuredClone(DEFAULT_STATUS_RULES),
		milestones: ["approved", "booked", "moved in"],
		...extra,
	};
}

function email(id: string, date: string, statusPhrases: string[], extra: Partial<EmailRecord> = {}): EmailRecord {
	return {
		id,
		fingerprint: id,
		messageId: null,
		subject: "Office move",
		from: "a@example.com",
		fromDomain: "example.com",
		date,
		importedAt: date,
		source: "eml",
		paths: [["t"]],
		manual: false,
		matchedKeywords: [],
		keywords: [],
		statusPhrases,
		...extra,
	};
}

describe("stripQuoted", () => {
	it("drops Gmail and Outlook reply history and > quotes", () => {
		const gmail = "All sorted now.\n\nOn Mon, 2 Nov 2026 at 09:15, Sam <sam@example.com>\nwrote:\n> Is this resolved yet?";
		expect(stripQuoted(gmail)).toBe("All sorted now.\n\n");
		const outlook = "Still not working.\n\nFrom: Sam\nSent: Monday\nTo: You\nSubject: Re: move\n\nThe task is resolved.";
		expect(stripQuoted(outlook)).not.toContain("resolved");
		expect(stripQuoted("Thanks\n> resolved\nBye")).toBe("Thanks\nBye");
	});
});

describe("detectPhrases", () => {
	it("finds phrases in the new text only, including the subject", () => {
		const phrases = allTaskPhrases([task()]);
		const found = detectPhrases("Re: Office move approved", "Great, the task is resolved.\n> waiting on approval", phrases);
		expect(found).toEqual(expect.arrayContaining(["approved", "resolved"]));
		expect(found).not.toContain("waiting on");
	});
});

describe("signalFor", () => {
	const rules = DEFAULT_STATUS_RULES;
	it("lets the longest phrase win, so 'not resolved' isn't Done", () => {
		expect(signalFor(email("1", "2026-11-01", ["resolved", "not resolved"]), rules)).toEqual({ status: "open", phrase: "not resolved" });
		expect(signalFor(email("2", "2026-11-01", ["resolved"]), rules)).toEqual({ status: "done", phrase: "resolved" });
		expect(signalFor(email("3", "2026-11-01", []), rules)).toBeNull();
	});

	it("also reads the stored subject and keywords", () => {
		expect(signalFor(email("4", "2026-11-01", [], { subject: "Move on hold" }), rules)?.status).toBe("waiting");
	});
});

describe("taskState", () => {
	const records = [
		email("1", "2026-11-01T09:00:00.000Z", []),
		email("2", "2026-11-02T09:00:00.000Z", ["approved", "pending"]),
		email("3", "2026-11-03T09:00:00.000Z", ["booked", "resolved"]),
		email("x", "2026-11-04T09:00:00.000Z", ["reopened"], { paths: [["other"]] }),
	];

	it("follows the newest signal and tracks milestones", () => {
		const s = taskState(task(), records);
		expect(s.status).toBe("done");
		expect(s.source).toBe("auto");
		expect(s.lastSignal?.phrase).toBe("resolved");
		expect(s.emailCount).toBe(3);
		expect(s.history.map((h) => h.status)).toEqual(["waiting", "done"]);
		expect(s.milestones.map((m) => [m.phrase, m.reachedAt?.toISOString() ?? null])).toEqual([
			["approved", "2026-11-02T09:00:00.000Z"],
			["booked", "2026-11-03T09:00:00.000Z"],
			["moved in", null],
		]);
	});

	it("starts open with no signals", () => {
		const s = taskState(task(), [records[0]]);
		expect(s).toMatchObject({ status: "open", source: "default", emailCount: 1 });
	});

	it("keeps your manual status until a newer email signals", () => {
		const held = taskState(task({ override: { status: "open", at: "2026-11-05T00:00:00.000Z" } }), records);
		expect(held).toMatchObject({ status: "open", source: "manual" });
		const newer = [...records, email("4", "2026-11-06T09:00:00.000Z", ["completed"])];
		expect(taskState(task({ override: { status: "open", at: "2026-11-05T00:00:00.000Z" } }), newer)).toMatchObject({
			status: "done",
			source: "auto",
		});
	});
});

describe("migration to task categories", () => {
	it("drops per-email status and gives categories default task fields", () => {
		const out = migrate(
			[{ id: "c", name: "C", parentIds: [], color: "#000", rule: emptyRule(), trackAsTask: true, dateGranularity: "week" } as never],
			[{ ...email("1", "2026-11-01", []), statusPhrases: undefined, status: "done", due: "2026-12-01", statusChangedAt: "x" } as never],
		);
		expect(out.categories[0].statusRules).toEqual(DEFAULT_STATUS_RULES);
		expect(out.categories[0].milestones).toEqual([]);
		expect(out.records[0]).not.toHaveProperty("status");
		expect(out.records[0]).not.toHaveProperty("due");
		expect(out.records[0].statusPhrases).toEqual([]);
	});
});
