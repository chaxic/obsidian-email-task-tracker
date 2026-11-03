import type { Category, CategoryPath, EmailRecord } from "../types";
import { evaluateRule, hasConditions, unique, type MatchInput, type RuleResult } from "./rules";

export interface Classification {
	paths: CategoryPath[];
	matchedKeywords: string[];
}

const MAX_DEPTH = 16;

export function childrenOf(categories: Category[], parentId: string | null): Category[] {
	return categories
		.filter((c) => (parentId === null ? c.parentIds.length === 0 : c.parentIds.includes(parentId)))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walk every route down the category tree.
 * - A category whose filter has conditions that fail blocks its child categories on that route.
 * - A category with no conditions is a group: it passes through but never matches by itself.
 * - A category whose conditions match records the route to it.
 * Only the longest routes are returned; [software, unity] already implies Software.
 */
export function classify(categories: Category[], input: MatchInput): Classification {
	const results = new Map<string, RuleResult>();
	const evaluate = (c: Category) => {
		let r = results.get(c.id);
		if (!r) results.set(c.id, (r = evaluateRule(c.rule, input)));
		return r;
	};

	const found: CategoryPath[] = [];
	const matched: string[] = [];
	const walk = (cat: Category, chain: CategoryPath) => {
		if (chain.includes(cat.id) || chain.length >= MAX_DEPTH) return;
		const gated = hasConditions(cat.rule);
		const r = gated ? evaluate(cat) : null;
		if (gated && !r!.matched) return;
		const here = [...chain, cat.id];
		if (r?.matched) {
			found.push(here);
			matched.push(...r.keywords);
		}
		for (const child of childrenOf(categories, cat.id)) walk(child, here);
	};
	for (const root of childrenOf(categories, null)) walk(root, []);

	return { paths: longestPaths(found), matchedKeywords: unique(matched) };
}

/** Drop paths that are a prefix of another path, and duplicates. */
export function longestPaths(paths: CategoryPath[]): CategoryPath[] {
	const keys = new Set<string>();
	const out: CategoryPath[] = [];
	for (const p of paths) {
		const key = p.join("/");
		if (keys.has(key)) continue;
		const isPrefix = paths.some((q) => q.length > p.length && p.every((id, i) => q[i] === id));
		if (!isPrefix) {
			keys.add(key);
			out.push(p);
		}
	}
	return out;
}

export function samePaths(a: CategoryPath[], b: CategoryPath[]): boolean {
	const key = (ps: CategoryPath[]) => ps.map((p) => p.join("/")).sort().join("|");
	return key(a) === key(b);
}

/**
 * Matching input rebuilt from what a record stores (the body is long gone).
 * Matched keywords are included so a re-run keeps matches that came from the body.
 */
export function inputFromRecord(record: EmailRecord): MatchInput {
	return {
		subject: record.subject ?? "",
		body: [...record.keywords, ...record.matchedKeywords].join("\n"),
		fromAddress: record.from,
		fromName: "",
	};
}

/** Every category id a record counts under. */
export function idsOf(record: EmailRecord): Set<string> {
	return new Set(record.paths.flat());
}

export function inCategory(record: EmailRecord, id: string): boolean {
	return record.paths.some((p) => p.includes(id));
}

export function isUncategorized(record: EmailRecord): boolean {
	return record.paths.length === 0;
}

export function pathLabel(categories: Category[], path: CategoryPath): string {
	if (!path.length) return "Uncategorized";
	const byId = new Map(categories.map((c) => [c.id, c.name]));
	return path.map((id) => byId.get(id) ?? "?").join(" › ");
}

/** "Unity (in Gaming, Software)" — a name that stays clear when a category is shared. */
export function categoryDisplayName(categories: Category[], id: string): string {
	const cat = categories.find((c) => c.id === id);
	if (!cat) return "?";
	const parents = cat.parentIds.map((p) => categories.find((c) => c.id === p)?.name).filter(Boolean);
	return parents.length ? `${cat.name} (in ${parents.join(", ")})` : cat.name;
}

export function sortedByDisplayName(categories: Category[]): Category[] {
	return [...categories].sort((a, b) => categoryDisplayName(categories, a.id).localeCompare(categoryDisplayName(categories, b.id)));
}

export function recordLabel(categories: Category[], record: EmailRecord): string {
	return record.paths.length ? record.paths.map((p) => pathLabel(categories, p)).join("; ") : "Uncategorized";
}

/** Every placement of every category, e.g. [gaming], [gaming, unity], [software, unity]. */
export function allPaths(categories: Category[]): CategoryPath[] {
	const out: CategoryPath[] = [];
	const walk = (cat: Category, chain: CategoryPath) => {
		if (chain.includes(cat.id) || chain.length >= MAX_DEPTH) return;
		const here = [...chain, cat.id];
		out.push(here);
		for (const child of childrenOf(categories, cat.id)) walk(child, here);
	};
	for (const root of childrenOf(categories, null)) walk(root, []);
	return out;
}

/** The category and everything below it, through any parent. */
export function subtreeIds(categories: Category[], id: string): Set<string> {
	const ids = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const c of categories) {
			if (!ids.has(c.id) && c.parentIds.some((p) => ids.has(p))) {
				ids.add(c.id);
				grew = true;
			}
		}
	}
	return ids;
}

/**
 * Set both directions for one category: its parents, and which categories sit
 * directly under it. Children keep their other parents. Returns a new list.
 */
export function applyRelationships(categories: Category[], id: string, parentIds: string[], childIds: string[]): Category[] {
	const children = new Set(childIds);
	return categories.map((c) => {
		if (c.id === id) return { ...c, parentIds: [...new Set(parentIds)] };
		const has = c.parentIds.includes(id);
		if (children.has(c.id) && !has) return { ...c, parentIds: [...c.parentIds, id] };
		if (!children.has(c.id) && has) return { ...c, parentIds: c.parentIds.filter((p) => p !== id) };
		return c;
	});
}

/** True if any category is (indirectly) its own parent. */
export function hasCycle(categories: Category[]): boolean {
	const byId = new Map(categories.map((c) => [c.id, c]));
	const state = new Map<string, 1 | 2>();
	const visit = (id: string): boolean => {
		if (state.get(id) === 2) return false;
		if (state.get(id) === 1) return true;
		state.set(id, 1);
		for (const p of byId.get(id)?.parentIds ?? []) if (byId.has(p) && visit(p)) return true;
		state.set(id, 2);
		return false;
	};
	return categories.some((c) => visit(c.id));
}

/** Two categories with the same name (ignoring case) under a shared parent, or both top-level. */
export function findNameClash(categories: Category[], ids: Iterable<string>): [Category, Category] | null {
	for (const id of ids) {
		const a = categories.find((c) => c.id === id);
		if (!a) continue;
		const b = categories.find(
			(c) =>
				c.id !== a.id &&
				c.name.toLowerCase() === a.name.toLowerCase() &&
				(a.parentIds.length ? c.parentIds.some((p) => a.parentIds.includes(p)) : c.parentIds.length === 0),
		);
		if (b) return [a, b];
	}
	return null;
}

/** True if giving `id` these parents would make it its own ancestor. */
export function wouldCreateCycle(categories: Category[], id: string, parentIds: string[]): boolean {
	const below = subtreeIds(categories, id);
	return parentIds.some((p) => below.has(p));
}
