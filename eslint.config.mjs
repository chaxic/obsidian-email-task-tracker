// Obsidian's official plugin guidelines, the same rules the community directory's automated review is based on.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "scripts/**", "tests/**", "esbuild.config.mjs", "eslint.config.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Product names keep their own capitalisation in UI text.
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["Obsidian", "Outlook", "Gmail"] }],
		},
	},
]);
