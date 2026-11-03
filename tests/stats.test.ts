import { describe, expect, it } from "vitest";
import { HERE_KEY, UNCAT_KEY, bucketKey, bucketRange, countBy, countByWeekdayHour, hasOverlap, seriesKeysFor, topSenders } from "../src/store/stats";
import { toCsv } from "../src/store/csv";

describe("buckets", () => {
	it("groups by Monday-start weeks and months", () => {
		const wed = new Date(2026, 10, 4);
		expect(bucketKey(wed, "day")).toBe("2026-11-04");
		expect(bucketKey(wed, "week")).toBe("2026-11-02");
		expect(bucketKey(wed, "month")).toBe("2026-11-01");
		expect(bucketKey(new Date(2026, 10, 8), "week")).toBe("2026-11-02");
	});

	it("lists every bucket in a range", () => {
		expect(bucketRange(new Date(2026, 9, 30), new Date(2026, 10, 2), "day")).toEqual([
			"2026-10-30",
			"2026-10-31",
			"2026-11-01",
			"2026-11-02",
		]);
		expect(bucketRange(new Date(2026, 8, 15), new Date(2026, 10, 3), "month")).toEqual([
			"2026-09-01",
			"2026-10-01",
			"2026-11-01",
		]);
	});
});

describe("csv", () => {
	it("quotes cells and neutralises formulas", () => {
		const csv = toCsv(
			[
				{
					id: "1",
					fingerprint: "f",
					messageId: null,
					subject: '=HYPERLINK("x"), "quoted"',
					from: "a@example.com",
					fromDomain: "example.com",
					date: "2026-11-01T00:00:00.000Z",
					importedAt: "2026-11-01T00:00:00.000Z",
					source: "eml",
					paths: [],
					manual: false,
					matchedKeywords: [],
					keywords: [],
					statusPhrases: [],
				},
			],
			[],
		);
		expect(csv.split("\r\n")[1]).toContain(`"'=HYPERLINK(""x""), ""quoted"""`);
	});
});

describe("aggregations", () => {
	const base = {
		fingerprint: "f",
		messageId: null,
		subject: null,
		importedAt: "2026-11-01T00:00:00.000Z",
		source: "eml" as const,
		manual: false,
		matchedKeywords: [],
		keywords: [],
		statusPhrases: [],
	};
	const records = [
		{ ...base, id: "1", from: "a@x.example.com", fromDomain: "x.example.com", date: new Date(2026, 10, 2, 9).toISOString(), paths: [["g", "u"], ["s", "u"]] },
		{ ...base, id: "2", from: "b@x.example.com", fromDomain: "x.example.com", date: new Date(2026, 10, 2, 9).toISOString(), paths: [["s"]] },
		{ ...base, id: "3", from: "a@x.example.com", fromDomain: "x.example.com", date: new Date(2026, 10, 8, 23).toISOString(), paths: [] },
	];

	it("splits records into series for the current selection", () => {
		expect(seriesKeysFor(records[0], null).sort()).toEqual(["g", "s"]);
		expect(seriesKeysFor(records[0], "s")).toEqual(["u"]);
		expect(seriesKeysFor(records[1], "s")).toEqual([HERE_KEY]);
		expect(seriesKeysFor(records[2], null)).toEqual([UNCAT_KEY]);
		expect(seriesKeysFor(records[2], "s")).toEqual([]);
		expect(hasOverlap(records, (r) => seriesKeysFor(r, null))).toBe(true);
		expect(hasOverlap(records, (r) => seriesKeysFor(r, "s"))).toBe(false);
	});

	it("builds weekday × hour and top senders", () => {
		const grid = countByWeekdayHour(records);
		expect(grid[0][9]).toBe(2); // Monday 09:00
		expect(grid[6][23]).toBe(1); // Sunday 23:00
		expect(topSenders(records, "address")).toEqual([
			{ label: "a@x.example.com", count: 2 },
			{ label: "b@x.example.com", count: 1 },
		]);
		expect(topSenders(records, "domain")).toEqual([{ label: "x.example.com", count: 3 }]);
		expect(countBy(records, (r) => seriesKeysFor(r, null)).get(UNCAT_KEY)).toBe(1);
	});
});
