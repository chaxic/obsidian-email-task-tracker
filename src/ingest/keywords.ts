const STOP_WORDS = new Set(
	`a about above after again against all also am an and any are aren as at be because been before being below
	between both but by can cannot could did didn do does doesn doing don down during each few for from further
	get got had has hasn have haven having he her here hers herself him himself his how i if in into is isn it its
	itself just let me more most my myself no nor not now of off on once only or other ought our ours ourselves
	out over own please re same she should so some such than thank thanks that the their theirs them themselves
	then there these they this those through to too under until up us very was wasn we were weren what when
	where which while who whom why will with won would you your yours yourself yourselves
	hi hello dear regards kind best cheers sent fw fwd subject email mail message original
	com www http https html mailto cid image png jpg gif`.split(/\s+/),
);

const TOKEN = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(TOKEN) ?? []).filter(
		(t) =>
			t.length >= 3 &&
			t.length <= 30 &&
			!STOP_WORDS.has(t) &&
			// Skip numbers, dates and ID-like strings: they identify people and
			// transactions without helping categorisation.
			!/\d/.test(t),
	);
}

/** Most significant terms in the email; subject words count three times. */
export function extractKeywords(subject: string, body: string, limit: number): string[] {
	if (limit <= 0) return [];
	const score = new Map<string, number>();
	for (const t of tokenize(subject)) score.set(t, (score.get(t) ?? 0) + 3);
	for (const t of tokenize(body)) score.set(t, (score.get(t) ?? 0) + 1);
	return [...score.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([t]) => t);
}
