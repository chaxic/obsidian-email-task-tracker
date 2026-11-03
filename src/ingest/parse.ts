import PostalMime from "postal-mime";
import MsgReader from "@kenjiuno/msgreader";
import { htmlToText } from "./text";

/** In-memory view of an email. Never persisted. */
export interface ParsedEmail {
	source: "eml" | "msg";
	messageId: string | null;
	subject: string;
	fromAddress: string;
	fromName: string;
	date: Date | null;
	body: string;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isEmailFileName(name: string): boolean {
	return /\.(eml|msg)$/i.test(name);
}

export function detectFormat(data: ArrayBuffer): "eml" | "msg" {
	const head = new Uint8Array(data, 0, Math.min(8, data.byteLength));
	return OLE_MAGIC.every((b, i) => head[i] === b) ? "msg" : "eml";
}

export async function parseEmail(data: ArrayBuffer): Promise<ParsedEmail> {
	return detectFormat(data) === "msg" ? parseMsg(data) : parseEml(data);
}

async function parseEml(data: ArrayBuffer): Promise<ParsedEmail> {
	// Attachments are decoded by the parser but dropped with the rest of this object.
	const email = await PostalMime.parse(data, { attachmentEncoding: "arraybuffer" });
	const from = email.from && !email.from.group ? email.from : undefined;
	const body = email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : "";
	return {
		source: "eml",
		messageId: cleanMessageId(email.messageId),
		subject: email.subject ?? "",
		fromAddress: (from?.address ?? "").toLowerCase(),
		fromName: from?.name ?? "",
		date: toDate(email.date),
		body,
	};
}

function parseMsg(data: ArrayBuffer): ParsedEmail {
	const msg = new MsgReader(data).getFileData();
	const headers = msg.headers ?? "";
	const headerFrom = /^From:.*?<([^>\s]+@[^>\s]+)>/im.exec(headers)?.[1];
	// Exchange senders often carry an X.500 path in senderEmail; prefer a real SMTP address.
	const fromAddress = [msg.senderSmtpAddress, msg.senderEmail, headerFrom].find((a) => a && a.includes("@")) ?? "";
	let body = msg.body ?? "";
	if (!body.trim()) {
		const html = msg.bodyHtml ?? (msg.html ? new TextDecoder().decode(msg.html) : "");
		body = html ? htmlToText(html) : "";
	}
	return {
		source: "msg",
		messageId: cleanMessageId(/^Message-ID:\s*(<[^>]+>)/im.exec(headers)?.[1]),
		subject: msg.subject ?? "",
		fromAddress: fromAddress.toLowerCase(),
		fromName: msg.senderName ?? "",
		date: toDate(msg.clientSubmitTime ?? msg.messageDeliveryTime ?? msg.creationTime),
		body,
	};
}

function cleanMessageId(id: string | undefined): string | null {
	const v = id?.trim().replace(/^<|>$/g, "");
	return v ? v : null;
}

function toDate(s: string | undefined): Date | null {
	if (!s) return null;
	const d = new Date(s);
	return isNaN(d.getTime()) ? null : d;
}
