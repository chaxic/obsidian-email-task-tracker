import { describe, expect, it } from "vitest";
import { normalizeCategories, normalizeRecords, normalizeSettings } from "../src/store/validate";
import { DEFAULT_PANELS, DEFAULT_SETTINGS } from "../src/types";
import { OTHER_COLOR } from "../src/ui/charts";

describe("normalizeSettings", () => {
	it("falls back to defaults for missing or malformed data", () => {
		expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
		const s = normalizeSettings({ storeSubject: "yes", keywordCount: 500, dropFolder: 3, autoLockMinutes: -5 });
		expect(s.storeSubject).toBe(DEFAULT_SETTINGS.storeSubject);
		expect(s.keywordCount).toBe(50);
		expect(s.dropFolder).toBe("");
		expect(s.autoLockMinutes).toBe(0);
	});

	it("drops chart panels this version doesn't know, so the dashboard can't crash", () => {
		const s = normalizeSettings({
			dashboardPanels: [
				{ id: "a", type: "activity", style: "lines", width: "full" },
				{ id: "b", type: "from-the-future", width: "half" },
				{ id: "c", type: "senders", width: "huge" },
				"junk",
			],
		});
		expect(s.dashboardPanels).toEqual([
			{ id: "a", type: "activity", style: "lines", width: "full" },
			{ id: "c", type: "senders", width: "half" },
		]);
		expect(normalizeSettings({ dashboardPanels: "x" }).dashboardPanels).toEqual(DEFAULT_PANELS);
	});

	it("drops keys it doesn't know, such as old categories", () => {
		expect(normalizeSettings({ categories: [1], encryption: {} })).not.toHaveProperty("categories");
	});
});

describe("normalizeCategories", () => {
	const base = { name: "A", rule: { anyOf: ["x"] } };

	it("only lets plain hex colours through, so CSS can't be injected", () => {
		const cats = normalizeCategories([
			{ ...base, id: "a", color: "red;background-image:url(https://example.com/x)" },
			{ ...base, id: "b", color: "#2a78d6" },
			{ ...base, id: "c", color: "url(https://example.com/x)" },
		]);
		expect(cats.map((c) => c.color)).toEqual([OTHER_COLOR, "#2a78d6", OTHER_COLOR]);
	});

	it("repairs fields and drops unusable or duplicate categories", () => {
		const cats = normalizeCategories([
			{ ...base, id: "a", parentIds: ["gone", "a", "b", 7], rule: { anyOf: ["vpn", 7], fields: ["subject", "bogus"] } },
			{ ...base, id: "b", override: { status: "lost", at: "x" }, statusRules: { done: ["fixed"] } },
			{ ...base, id: "a", name: "Duplicate" },
			{ ...base, id: "x/y" },
			{ name: "No id" },
			null,
		]);
		expect(cats.map((c) => c.id)).toEqual(["a", "b"]);
		expect(cats[0].parentIds).toEqual(["b"]);
		expect(cats[0].rule.anyOf).toEqual(["vpn"]);
		expect(cats[0].rule.fields).toEqual(["subject"]);
		expect(cats[1].override).toBeUndefined();
		expect(cats[1].statusRules).toEqual({ done: ["fixed"], waiting: [], open: [] });
	});
});

describe("normalizeRecords", () => {
	it("keeps records with an id and date, and repairs the rest", () => {
		const recs = normalizeRecords([
			{ id: "1", date: "2026-11-01T00:00:00.000Z", from: "A@example.com", paths: [["a", "b"], [], ["x/y"], "a"], keywords: "oops" },
			{ id: "2", date: "not a date" },
			{ date: "2026-11-01T00:00:00.000Z" },
		]);
		expect(recs).toHaveLength(1);
		expect(recs[0].paths).toEqual([["a", "b"]]);
		expect(recs[0].keywords).toEqual([]);
		expect(recs[0].fromDomain).toBe("example.com");
		expect(recs[0].source).toBe("eml");
	});
});
