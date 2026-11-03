import type { DateGranularity, EmailRecord } from "../types";

/** Start of the bucket (local time) a date falls in, as a sortable key. */
export function bucketKey(date: Date, granularity: DateGranularity): string {
	const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (granularity === "week") {
		// Weeks start on Monday.
		d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	} else if (granularity === "month") {
		d.setDate(1);
	}
	return localIsoDate(d);
}

export function localIsoDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every bucket key from `from` to `to`, so empty periods still show. */
export function bucketRange(from: Date, to: Date, granularity: DateGranularity, max = 400): string[] {
	const keys: string[] = [];
	const cur = new Date(bucketKey(from, granularity) + "T00:00:00");
	const end = bucketKey(to, granularity);
	while (keys.length < max) {
		const key = localIsoDate(cur);
		keys.push(key);
		if (key >= end) break;
		if (granularity === "day") cur.setDate(cur.getDate() + 1);
		else if (granularity === "week") cur.setDate(cur.getDate() + 7);
		else cur.setMonth(cur.getMonth() + 1);
	}
	return keys;
}

export interface Series {
	key: string;
	label: string;
	color: string;
	values: number[];
}

export const UNCAT_KEY = "__uncategorized__";
/** Records sitting at the selected category itself rather than in a child category. */
export const HERE_KEY = "__here__";

/**
 * Which series a record contributes to when looking at `selected`
 * (null = everything). A record in several categories can return several keys.
 */
export function seriesKeysFor(record: EmailRecord, selected: string | null): string[] {
	if (!record.paths.length) return selected === null || selected === UNCAT_KEY ? [UNCAT_KEY] : [];
	if (selected === UNCAT_KEY) return [];
	const keys = new Set<string>();
	for (const p of record.paths) {
		if (selected === null) {
			keys.add(p[0]);
			continue;
		}
		const i = p.indexOf(selected);
		if (i < 0) continue;
		keys.add(i === p.length - 1 ? HERE_KEY : p[i + 1]);
	}
	return [...keys];
}

/** Count records per bucket, split into series by `seriesOf`. */
export function countByBucket(
	records: EmailRecord[],
	buckets: string[],
	granularity: DateGranularity,
	seriesOf: (r: EmailRecord) => string[],
): Map<string, number[]> {
	const index = new Map(buckets.map((b, i) => [b, i]));
	const out = new Map<string, number[]>();
	for (const r of records) {
		const i = index.get(bucketKey(new Date(r.date), granularity));
		if (i === undefined) continue;
		for (const s of seriesOf(r)) {
			let arr = out.get(s);
			if (!arr) out.set(s, (arr = new Array(buckets.length).fill(0)));
			arr[i]++;
		}
	}
	return out;
}

export function countBy(records: EmailRecord[], keysOf: (r: EmailRecord) => string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of records) for (const k of keysOf(r)) out.set(k, (out.get(k) ?? 0) + 1);
	return out;
}

/** True if any record would be counted in more than one series. */
export function hasOverlap(records: EmailRecord[], keysOf: (r: EmailRecord) => string[]): boolean {
	return records.some((r) => keysOf(r).length > 1);
}

/** 7 rows (Monday first) × 24 hours, local time. */
export function countByWeekdayHour(records: EmailRecord[]): number[][] {
	const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
	for (const r of records) {
		const d = new Date(r.date);
		grid[(d.getDay() + 6) % 7][d.getHours()]++;
	}
	return grid;
}

export function countByDay(records: EmailRecord[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of records) {
		const k = localIsoDate(new Date(r.date));
		out.set(k, (out.get(k) ?? 0) + 1);
	}
	return out;
}

export function topSenders(records: EmailRecord[], by: "address" | "domain", limit = 10): { label: string; count: number }[] {
	const counts = countBy(records, (r) => [by === "domain" ? r.fromDomain || "(unknown)" : r.from || "(unknown)"]);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([label, count]) => ({ label, count }));
}

export function daysBetween(a: Date, b: Date): number {
	return Math.max(0, (b.getTime() - a.getTime()) / 86_400_000);
}
