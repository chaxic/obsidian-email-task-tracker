// Copy the built plugin into a test vault, named by the OBSIDIAN_VAULT environment variable.
import { copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const vault = process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error("Set OBSIDIAN_VAULT to the folder of the vault to deploy into, e.g. OBSIDIAN_VAULT=/path/to/vault npm run deploy");
	process.exit(1);
}
const dest = join(vault, ".obsidian", "plugins", "email-task-tracker");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(dest, f));
console.log(`Deployed to ${dest}`);
