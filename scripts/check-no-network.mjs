// Fails the build if the bundled plugin contains anything that can make a network request.
// It scans main.js after bundling, so third-party dependencies are covered too.
import { readFileSync } from "fs";

const code = readFileSync("main.js", "utf8");

const forbidden = [
	[/\bfetch\s*\(/, "fetch()"],
	[/\bXMLHttpRequest\b/, "XMLHttpRequest"],
	[/\bWebSocket\b/, "WebSocket"],
	[/\bEventSource\b/, "EventSource"],
	[/\bsendBeacon\b/, "navigator.sendBeacon"],
	[/\brequestUrl\b/, "Obsidian requestUrl"],
	[/require\(\s*["'](node:)?(http|https|http2|net|tls|dgram|dns|child_process)["']\s*\)/, "Node network/process module"],
	[/require\(\s*["']electron["']\s*\)/, "electron"],
	[/\bnew\s+Image\s*\(/, "new Image()"],
	[/\bimportScripts\b/, "importScripts"],
	[/\bimport\s*\(/, "dynamic import()"],
	[/\bRTCPeerConnection\b/, "RTCPeerConnection"],
	[/\bnew\s+(?:Shared)?Worker\s*\(/, "Web Worker"],
	[/\.src\s*=(?!=)/, "src assignment"],
	[/\burl\s*\(\s*["']?(?:[a-z]+:)?\/\//i, "CSS url() to a remote host"],
];

// The only URL the plugin may contain: the optional, click-only Gmail search link.
// Anything else listed here is plain text in a dependency's error message, never requested.
const allowedUrls = new Set([
	"https://mail.google.com/mail/u/0/#search/rfc822msgid%3A",
	"https://github.com/ashtuchkin/iconv-lite/wiki/Use-Buffers-when-decoding",
]);
const allowedPrefixes = ["http://www.w3.org/"];

const problems = [];
for (const [re, label] of forbidden) {
	const m = re.exec(code);
	if (m) problems.push(`${label} near: ${code.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, " ")}`);
}
for (const m of code.matchAll(/(?:https?|wss?|ftp):\/\/[^\s"'`)$]*/g)) {
	if (!allowedUrls.has(m[0]) && !allowedPrefixes.some((p) => m[0].startsWith(p))) problems.push(`URL: ${m[0]}`);
}

if (problems.length) {
	console.error("Network guard FAILED. The bundle contains:\n  " + problems.join("\n  "));
	process.exit(1);
}
console.log(`Network guard passed (${(code.length / 1024).toFixed(0)} KB scanned).`);
