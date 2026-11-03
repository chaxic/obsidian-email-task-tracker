import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

// Bundled third-party code must carry its license notices. Full texts: THIRD_PARTY_LICENSES.md in the repository.
const banner = `/*
Email Task Tracker (MIT) - github.com/chaxic/obsidian-email-task-tracker
Bundles: @kenjiuno/msgreader (Apache-2.0), @kenjiuno/decompressrtf (BSD-2-Clause),
postal-mime (MIT-0), iconv-lite (MIT), safer-buffer (MIT).
License texts: THIRD_PARTY_LICENSES.md in the repository above.
*/`;

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	legalComments: "eof",
	banner: { js: banner },
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
