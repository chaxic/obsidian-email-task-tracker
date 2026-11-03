/**
 * Convert an HTML email body to plain text for keyword matching.
 *
 * DOMParser documents have no browsing context, so nothing inside them is
 * fetched or executed: tracking pixels and remote images never load.
 * The regex fallback is only used outside the browser (unit tests).
 */
export function htmlToText(html: string): string {
	if (typeof DOMParser !== "undefined") {
		const doc = new DOMParser().parseFromString(html, "text/html");
		doc.querySelectorAll("script, style, head").forEach((el) => el.remove());
		// textContent drops line breaks; keep them so reply headers stay on their own lines.
		doc.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
		doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, hr").forEach((el) => el.append("\n"));
		return collapse(doc.body?.textContent ?? "");
	}
	return collapse(
		decodeEntities(
			html
				.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
				.replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
				.replace(/<[^>]+>/g, " "),
		),
	);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/gi, "&");
}

function collapse(s: string): string {
	return s.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

const REPLY_HEADERS = [
	// Gmail / Apple Mail: "On Mon, 2 Nov 2026 at 09:15, Name <name@example.com> wrote:" (may wrap)
	/^On [\s\S]{1,200}?wrote:[ \t]*$/m,
	// Outlook
	/^-{2,}\s*Original Message\s*-{2,}/im,
	/^From:[^\n]*\n(?:[^\n]*\n){0,3}?(?:Sent|Date):/m,
	/^_{10,}[ \t]*$/m,
];

/** Drop quoted reply history so old messages in a thread don't count as new activity. */
export function stripQuoted(body: string): string {
	let end = body.length;
	for (const re of REPLY_HEADERS) {
		const m = re.exec(body);
		if (m && m.index < end) end = m.index;
	}
	return body
		.slice(0, end)
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}
