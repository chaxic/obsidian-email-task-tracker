import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { detectFormat, parseEmail } from "../src/ingest/parse";
import { extractKeywords, tokenize } from "../src/ingest/keywords";
import { htmlToText } from "../src/ingest/text";
import { buildRecord } from "../src/store/records";
import { DEFAULT_SETTINGS, DEFAULT_STATUS_RULES } from "../src/types";
import { taskState } from "../src/classify/tasks";

function fixture(name: string): ArrayBuffer {
	const buf = readFileSync(join(__dirname, "fixtures", "synthetic", name));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const none = { paths: [], matchedKeywords: [] };

describe("parseEmail", () => {
	it("reads headers and plain-text body", async () => {
		const e = await parseEmail(fixture("support-request.eml"));
		expect(e.source).toBe("eml");
		expect(e.messageId).toBe("synthetic-0001@help.example.com");
		expect(e.subject).toBe("Unity licence renewal for the studio");
		expect(e.fromAddress).toBe("support@help.example.com");
		expect(e.date?.toISOString()).toBe("2026-11-02T09:15:00.000Z");
		expect(e.body).toContain("editor opens");
	});

	it("turns HTML-only bodies into text without scripts or styles", async () => {
		const e = await parseEmail(fixture("html-only.eml"));
		expect(e.body).toContain("roadmap & release notes");
		expect(e.body).not.toContain("alert");
		expect(e.body).not.toContain("color:red");
		expect(e.body).not.toContain("tracker.example.net");
	});

	it("decodes encoded subjects and handles missing Message-ID", async () => {
		const e = await parseEmail(fixture("invoice-attachment.eml"));
		expect(e.subject).toBe("Invoice due – November");
		expect(e.messageId).toBeNull();
		expect(e.body).toContain("invoice for November");
	});

	it("detects Outlook .msg files by their signature", () => {
		const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]).buffer;
		expect(detectFormat(ole)).toBe("msg");
		expect(detectFormat(fixture("support-request.eml"))).toBe("eml");
	});
});

describe("stored record", () => {
	it("keeps only single keywords from the body, never its sentences or recipients", async () => {
		const parsed = await parseEmail(fixture("support-request.eml"));
		const record = buildRecord(parsed, none, DEFAULT_SETTINGS, []);
		const json = JSON.stringify(record);
		expect(record.keywords.every((k) => /^[\p{L}'’.-]+$/u.test(k))).toBe(true);
		expect(json).not.toContain("SECRETBODYMARKER");
		expect(json).not.toContain("cannot activate");
		expect(json).not.toContain("user@example.com");
		expect(json).not.toContain("48213");
		expect(record.keywords.length).toBeLessThanOrEqual(DEFAULT_SETTINGS.keywordCount);
	});

	it("omits the subject and keywords when storage is turned down", async () => {
		const parsed = await parseEmail(fixture("support-request.eml"));
		const record = buildRecord(parsed, none, { ...DEFAULT_SETTINGS, storeSubject: false, keywordCount: 0 }, []);
		expect(record.subject).toBeNull();
		expect(record.keywords).toEqual([]);
		const json = JSON.stringify(record).toLowerCase();
		expect(json).not.toContain("licence");
		expect(json).not.toContain("secretbodymarker");
	});

	it("never stores attachment content", async () => {
		const parsed = await parseEmail(fixture("invoice-attachment.eml"));
		const json = JSON.stringify(buildRecord(parsed, none, DEFAULT_SETTINGS, []));
		expect(json).not.toContain("JVBERi0");
		expect(json).not.toContain("invoice.pdf");
	});
});

describe("keywords", () => {
	it("drops stop words, numbers and short tokens", () => {
		expect(tokenize("Hi the build is broken, ticket 48213 ok")).toEqual(["build", "broken", "ticket"]);
	});

	it("weights subject terms above body terms", () => {
		expect(extractKeywords("Unity", "photoshop photoshop", 2)[0]).toBe("unity");
	});

	it("strips markup in the text fallback", () => {
		expect(htmlToText("<p>a &amp; b</p><script>x()</script>")).toBe("a & b");
	});
});

describe("task phrases at import", () => {
	it("records status and milestone phrases from the new text only", async () => {
		const parsed = await parseEmail(fixture("task-update.eml"));
		const task = {
			id: "t",
			name: "Office move",
			parentIds: [],
			color: "#888",
			rule: { anyOf: ["office move"], allOf: [], noneOf: [], senders: [], domains: [], fields: ["subject" as const, "body" as const] },
			trackAsTask: true,
			dateGranularity: "week" as const,
			statusRules: DEFAULT_STATUS_RULES,
			milestones: ["approved", "booked"],
		};
		const record = buildRecord(parsed, { paths: [["t"]], matchedKeywords: [] }, DEFAULT_SETTINGS, [task]);
		expect(record.statusPhrases).toEqual(expect.arrayContaining(["resolved", "booked"]));
		expect(record.statusPhrases).not.toContain("still not working");
		expect(record.statusPhrases).not.toContain("waiting on");
		expect(taskState(task, [record])).toMatchObject({ status: "done", source: "auto" });
	});
});
