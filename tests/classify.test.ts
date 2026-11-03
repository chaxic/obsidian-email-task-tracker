import { describe, expect, it } from "vitest";
import { allPaths, applyRelationships, classify, findNameClash, hasCycle, longestPaths, pathLabel, subtreeIds, wouldCreateCycle } from "../src/classify/engine";
import { containsTerm, evaluateRule, type MatchInput } from "../src/classify/rules";
import { deleteCategory, reclassify, removeFromParent } from "../src/store/records";
import { emptyRule, type Category, type EmailRecord, type Rule } from "../src/types";

function cat(id: string, rule: Partial<Rule>, extra: Partial<Category> = {}): Category {
	return {
		id,
		name: id,
		parentIds: [],
		color: "#888",
		rule: { ...emptyRule(), ...rule },
		trackAsTask: false,
		dateGranularity: "week",
		statusRules: { done: [], waiting: [], open: [] },
		milestones: [],
		...extra,
	};
}

function input(subject: string, body = "", fromAddress = "someone@example.com"): MatchInput {
	return { subject, body, fromAddress, fromName: "" };
}

function rec(id: string, subject: string, keywords: string[], extra: Partial<EmailRecord> = {}): EmailRecord {
	return {
		id,
		fingerprint: id,
		messageId: null,
		subject,
		from: "a@example.com",
		fromDomain: "example.com",
		date: "2026-11-01T00:00:00.000Z",
		importedAt: "2026-11-01T00:00:00.000Z",
		source: "eml",
		paths: [],
		manual: false,
		matchedKeywords: [],
		keywords,
		statusPhrases: [],
		...extra,
	};
}

// Gaming and Software are groups (no filter of their own); Unity is shared by both.
const tree = (): Category[] => [
	cat("Gaming", {}),
	cat("Software", {}, { trackAsTask: true }),
	cat("Unity", { anyOf: ["unity"] }, { parentIds: ["Gaming", "Software"] }),
	cat("80 Level", { anyOf: ["80 level"] }, { parentIds: ["Gaming"] }),
	cat("Adobe", { anyOf: ["photoshop", "adobe"] }, { parentIds: ["Software"] }),
	cat("Windows", { anyOf: ["windows"] }, { parentIds: ["Software"] }),
	cat("Finance", { domains: ["vendor.example.com"] }),
];

describe("containsTerm", () => {
	it("matches whole words and phrases, case-insensitively", () => {
		expect(containsTerm("New Unity release!", "unity")).toBe(true);
		expect(containsTerm("community", "unity")).toBe(false);
		expect(containsTerm("80\n  Level article", "80 level")).toBe(true);
		expect(containsTerm("c++ build", "c++")).toBe(true);
	});
});

describe("evaluateRule", () => {
	it("requires every condition group that has entries", () => {
		const rule = { ...emptyRule(), anyOf: ["invoice"], domains: ["vendor.example.com"] };
		expect(evaluateRule(rule, input("Invoice", "", "a@vendor.example.com")).matched).toBe(true);
		expect(evaluateRule(rule, input("Invoice", "", "a@other.example.com")).matched).toBe(false);
		expect(evaluateRule(rule, input("Hello", "", "a@vendor.example.com")).matched).toBe(false);
	});

	it("matches subdomains and exact senders", () => {
		const rule = { ...emptyRule(), domains: ["@example.com"] };
		expect(evaluateRule(rule, input("", "", "x@mail.example.com")).matched).toBe(true);
		expect(evaluateRule(rule, input("", "", "x@badexample.com")).matched).toBe(false);
		const s = { ...emptyRule(), senders: ["Someone@Example.com"] };
		expect(evaluateRule(s, input("", "", "someone@example.com")).matched).toBe(true);
	});

	it("excludes on noneOf and never matches an empty rule", () => {
		const rule = { ...emptyRule(), anyOf: ["unity"], noneOf: ["newsletter"] };
		expect(evaluateRule(rule, input("Unity newsletter")).matched).toBe(false);
		expect(evaluateRule({ ...emptyRule(), noneOf: ["x"] }, input("anything")).matched).toBe(false);
	});

	it("needs all allOf terms and only checks the chosen fields", () => {
		const rule = { ...emptyRule(), allOf: ["order", "shipped"], fields: ["subject" as const] };
		expect(evaluateRule(rule, input("Order shipped")).matched).toBe(true);
		expect(evaluateRule(rule, input("Order", "shipped")).matched).toBe(false);
	});
});

describe("classify with shared sub-categories", () => {
	it("counts a shared sub-category under every parent", () => {
		const cats = tree();
		const r = classify(cats, input("Unity 6 is out"));
		expect(r.paths.map((p) => pathLabel(cats, p)).sort()).toEqual(["Gaming › Unity", "Software › Unity"]);
	});

	it("lets an email sit in several unrelated categories", () => {
		const cats = tree();
		const r = classify(cats, input("Photoshop invoice", "", "billing@vendor.example.com"));
		expect(r.paths.map((p) => pathLabel(cats, p)).sort()).toEqual(["Finance", "Software › Adobe"]);
	});

	it("blocks a route when the parent has its own filter and it fails", () => {
		const cats = tree().map((c) => (c.id === "Software" ? { ...c, rule: { ...c.rule, domains: ["software.example.com"] } } : c));
		const r = classify(cats, input("Unity 6 is out", "", "news@other.example.com"));
		expect(r.paths.map((p) => pathLabel(cats, p))).toEqual(["Gaming › Unity"]);
		const viaVendor = classify(cats, input("Unity 6 is out", "", "a@software.example.com"));
		expect(viaVendor.paths.map((p) => pathLabel(cats, p)).sort()).toEqual(["Gaming › Unity", "Software › Unity"]);
	});

	it("a group with no filter never matches on its own", () => {
		expect(classify(tree(), input("Gaming Software")).paths).toEqual([]);
	});

	it("keeps only the longest route when parent and child both match", () => {
		const cats = tree().map((c) => (c.id === "Gaming" ? { ...c, rule: { ...c.rule, anyOf: ["game", "unity"] } } : c));
		const r = classify(cats, input("Unity game jam"));
		expect(r.paths).toContainEqual(["Gaming", "Unity"]);
		expect(r.paths).not.toContainEqual(["Gaming"]);
	});

	it("survives a cycle in saved data", () => {
		const cats = [cat("A", { anyOf: ["x"] }, { parentIds: ["B"] }), cat("B", { anyOf: ["x"] }, { parentIds: ["A"] }), cat("Top", { anyOf: ["x"] })];
		expect(classify(cats, input("x")).paths).toEqual([["Top"]]);
	});

	it("returns nothing when nothing matches", () => {
		expect(classify(tree(), input("Lunch on Friday?")).paths).toEqual([]);
	});
});

describe("tree helpers", () => {
	it("lists every placement", () => {
		const cats = tree();
		const labels = allPaths(cats).map((p) => pathLabel(cats, p));
		expect(labels).toContain("Gaming › Unity");
		expect(labels).toContain("Software › Unity");
		// Finance, Gaming (+Unity, 80 Level), Software (+Unity, Adobe, Windows)
		expect(labels).toHaveLength(8);
	});

	it("finds subtrees and prevents cycles", () => {
		const cats = tree();
		expect([...subtreeIds(cats, "Software")].sort()).toEqual(["Adobe", "Software", "Unity", "Windows"]);
		expect(wouldCreateCycle(cats, "Software", ["Unity"])).toBe(true);
		expect(wouldCreateCycle(cats, "Unity", ["Finance"])).toBe(false);
	});

	it("drops prefix paths", () => {
		expect(longestPaths([["a"], ["a", "b"], ["c"], ["a", "b"]])).toEqual([["a", "b"], ["c"]]);
	});
});

describe("reclassify", () => {
	it("uses stored subject and keywords, and leaves manual records alone", () => {
		const cats = tree();
		const records = [rec("1", "Hello", ["windows", "update"]), rec("2", "Hello", ["lunch"]), rec("3", "Unity", [], { manual: true })];
		expect(reclassify(records, cats)).toBe(1);
		expect(records[0].paths).toEqual([["Software", "Windows"]]);
		expect(records[2].paths).toEqual([]);
	});
});

describe("deleting and detaching", () => {
	it("deleting a parent moves orphaned children up and strips it from records", () => {
		const records = [rec("1", "Unity", [], { paths: [["Gaming", "Unity"], ["Gaming", "80 Level"]] })];
		const cats = deleteCategory(tree(), records, "Gaming");
		expect(cats.find((c) => c.id === "Unity")!.parentIds).toEqual(["Software"]);
		expect(cats.find((c) => c.id === "80 Level")!.parentIds).toEqual([]);
		expect(records[0].paths).toEqual([["Unity"], ["80 Level"]]);
	});

	it("removing one placement keeps the others", () => {
		const records = [rec("1", "Unity", [], { paths: [["Gaming", "Unity"], ["Software", "Unity"]] })];
		const cats = removeFromParent(tree(), records, "Unity", "Gaming");
		expect(cats.find((c) => c.id === "Unity")!.parentIds).toEqual(["Software"]);
		expect(records[0].paths).toEqual([["Gaming"], ["Software", "Unity"]]);
		reclassify(records, cats);
		expect(records[0].paths).toEqual([["Software", "Unity"]]);
	});
});

describe("re-running keeps body matches", () => {
	it("uses matched keywords even when they aren't among the stored top keywords", () => {
		const cats = tree();
		const r = rec("1", "Quick question", ["question"], { paths: [["Software", "Windows"]], matchedKeywords: ["windows"] });
		expect(reclassify([r], cats)).toBe(0);
		expect(r.paths).toEqual([["Software", "Windows"]]);
	});
});

describe("applyRelationships", () => {
	it("adds children while keeping their other parents, and removes unticked ones", () => {
		const base = tree();
		// Edit Gaming: keep 80 Level, drop Unity, adopt Windows.
		const next = applyRelationships(base, "Gaming", [], ["80 Level", "Windows"]);
		const parents = (id: string) => next.find((c) => c.id === id)!.parentIds;
		expect(parents("Windows").sort()).toEqual(["Gaming", "Software"]);
		expect(parents("Unity")).toEqual(["Software"]);
		expect(parents("80 Level")).toEqual(["Gaming"]);
		expect(hasCycle(next)).toBe(false);
	});

	it("sets parents and detects loops", () => {
		const next = applyRelationships(tree(), "Gaming", ["Unity"], ["Unity"]);
		expect(hasCycle(next)).toBe(true);
		expect(hasCycle(tree())).toBe(false);
	});

	it("finds name clashes at the same level only", () => {
		const cats = [...tree(), cat("x1", {}, { name: "unity", parentIds: ["Gaming"] }), cat("x2", {}, { name: "Gaming" })];
		expect(findNameClash(cats, ["x1"])?.[1].id).toBe("Unity");
		expect(findNameClash(cats, ["x2"])?.[1].id).toBe("Gaming");
		expect(findNameClash(tree(), ["Adobe", "Windows"])).toBeNull();
	});
});
