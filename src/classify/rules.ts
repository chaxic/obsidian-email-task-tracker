import type { MatchField, Rule } from "../types";

/** Text the rules are checked against. For stored records `body` is the saved keyword list. */
export interface MatchInput {
	subject: string;
	body: string;
	fromAddress: string;
	fromName: string;
}

export interface RuleResult {
	matched: boolean;
	keywords: string[];
}

const patternCache = new Map<string, RegExp>();

/** Case-insensitive, whole-word (or whole-phrase) match. */
export function containsTerm(text: string, term: string): boolean {
	const key = term.toLowerCase().trim();
	if (!key) return false;
	let re = patternCache.get(key);
	if (!re) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
		re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
		patternCache.set(key, re);
	}
	return re.test(text);
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function hasConditions(rule: Rule): boolean {
	return (
		rule.anyOf.length + rule.allOf.length + rule.senders.length + rule.domains.length > 0
	);
}

/**
 * Every condition group that has entries must pass (like an Outlook rule).
 * `noneOf` only excludes; a rule with nothing but `noneOf` never matches.
 */
export function evaluateRule(rule: Rule, input: MatchInput): RuleResult {
	const none: RuleResult = { matched: false, keywords: [] };
	if (!hasConditions(rule)) return none;

	const from = input.fromAddress.toLowerCase();
	if (rule.senders.length && !rule.senders.some((s) => s.trim().toLowerCase() === from)) return none;
	if (rule.domains.length) {
		const domain = domainOf(from);
		const ok = rule.domains.some((d) => {
			const want = d.trim().toLowerCase().replace(/^@/, "");
			return domain === want || domain.endsWith("." + want);
		});
		if (!ok) return none;
	}

	const haystack = buildHaystack(rule.fields, input);
	if (rule.noneOf.some((k) => containsTerm(haystack, k))) return none;
	if (!rule.allOf.every((k) => containsTerm(haystack, k))) return none;
	const anyHits = rule.anyOf.filter((k) => containsTerm(haystack, k));
	if (rule.anyOf.length && !anyHits.length) return none;

	return { matched: true, keywords: unique([...rule.allOf, ...anyHits].map((k) => k.trim())) };
}

function buildHaystack(fields: MatchField[], input: MatchInput): string {
	const parts: string[] = [];
	if (fields.includes("subject")) parts.push(input.subject);
	if (fields.includes("body")) parts.push(input.body);
	if (fields.includes("from")) parts.push(input.fromName, input.fromAddress);
	return parts.join("\n");
}

export function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}
