import { FileSystemAdapter, Notice, Plugin, normalizePath } from "obsidian";
import { watch, type FSWatcher } from "fs";
import { readdir, readFile, stat, unlink } from "fs/promises";
import { join, resolve, sep } from "path";
import type { Category, TaskStatus, TrackerSettings } from "./types";
import { isObject, normalizeSettings } from "./store/validate";
import { isEmailFileName, parseEmail } from "./ingest/parse";
import { classify, pathLabel } from "./classify/engine";
import {
	RecordStore,
	buildRecord,
	deleteCategory,
	fingerprintOf,
	reclassify,
	removeFromParent,
	type Persistence,
} from "./store/records";
import { toCsv } from "./store/csv";
import { localIsoDate } from "./store/stats";
import { DashboardView, VIEW_TYPE } from "./ui/DashboardView";
import { TrackerSettingTab } from "./ui/SettingsTab";
import { ConfirmModal } from "./ui/ConfirmModal";
import { PassphraseModal } from "./ui/PassphraseModal";

const MAX_EMAIL_BYTES = 50 * 1024 * 1024;
const EMAIL_MIME_TYPES = new Set(["message/rfc822", "application/vnd.ms-outlook"]);

export interface ImportItem {
	name: string;
	/** Size in bytes when known up front, so oversized files are rejected without reading them. */
	size?: number;
	read(): Promise<ArrayBuffer>;
}

type ImportOutcome = "added" | "duplicate" | "failed";

export default class EmailTrackerPlugin extends Plugin {
	settings!: TrackerSettings;
	store!: RecordStore;
	private watcher: FSWatcher | null = null;
	private scanTimer: number | null = null;
	private seenInDropFolder = new Set<string>();
	private lastActivity = Date.now();
	private unlockPrompt: Promise<boolean> | null = null;
	private watchedWindows = new WeakSet<Window>();

	get categories(): Category[] {
		return this.store.categories;
	}

	async onload(): Promise<void> {
		const legacyCategories = await this.loadSettings();
		this.store = new RecordStore(this.recordsFile());
		await this.store.load(legacyCategories);
		this.reportStoreProblem();
		await this.checkEncryptionExpected();
		if (legacyCategories.length && !this.store.locked) {
			// Categories moved from data.json into records.json in v2. Write the new
			// file first, then drop them from data.json.
			await this.store.save();
			await this.saveSettings();
		}

		this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
		this.addRibbonIcon("mail", "Open email tracker", () => void this.activateView());
		this.addSettingTab(new TrackerSettingTab(this.app, this));

		this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.activateView() });
		this.addCommand({ id: "import-files", name: "Import email files…", callback: () => this.pickFiles() });
		this.addCommand({ id: "rerun-filters", name: "Re-run filters", callback: () => void this.rerunFilters() });
		this.addCommand({ id: "scan-drop-folder", name: "Import from drop folder", callback: () => void this.scanDropFolder() });
		this.addCommand({ id: "export-csv", name: "Export records to CSV", callback: () => void this.exportCsv() });
		this.addCommand({ id: "purge", name: "Delete all records", callback: () => void this.confirmPurge() });
		this.addCommand({
			id: "lock",
			name: "Lock now",
			checkCallback: (checking) => {
				if (!this.store.encrypted || this.store.locked) return false;
				if (!checking) void this.lock();
				return true;
			},
		});
		this.addCommand({
			id: "unlock",
			name: "Unlock",
			checkCallback: (checking) => {
				if (!this.store.locked) return false;
				if (!checking) void this.ensureUnlocked();
				return true;
			},
		});

		// Email drops and activity (for auto-lock) are watched in every window, pop-outs included.
		this.watchWindow(window);
		this.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.watchWindow(win)));
		this.registerInterval(window.setInterval(() => void this.checkIdle(), 30_000));

		this.app.workspace.onLayoutReady(() => {
			// Pop-outs restored with the layout opened before this plugin was listening.
			this.app.workspace.iterateAllLeaves((leaf) => this.watchWindow(leaf.view.containerEl.win));
			this.startDropFolderWatch();
		});
	}

	private watchWindow(win: Window): void {
		if (this.watchedWindows.has(win)) return;
		this.watchedWindows.add(win);
		// Capture email files dropped anywhere in Obsidian, before the editor or file
		// explorer can copy them into the vault as attachments.
		this.registerDomEvent(win, "drop", (evt) => this.onWindowDrop(evt), { capture: true });
		const touch = () => (this.lastActivity = Date.now());
		this.registerDomEvent(win, "keydown", touch, { capture: true });
		this.registerDomEvent(win, "pointerdown", touch, { capture: true });
	}

	/** Tell the user if records.json couldn't be fully read, and where the original was kept. */
	private reportStoreProblem(): void {
		const p = this.store.problem;
		if (!p) return;
		this.store.problem = null;
		const what =
			p.kind === "unreadable"
				? "The records file couldn't be read, so the tracker started empty."
				: `${p.count} damaged categor${p.count === 1 ? "y or record was" : "ies or records were"} skipped.`;
		const kept = p.backupPath ? ` The original file was kept as ${p.backupPath}.` : "";
		new Notice(`Email Task Tracker: ${what}${kept}`, 0);
	}

	/**
	 * Encryption was on, but records.json is now plain or missing: it may have been replaced
	 * by a sync conflict or an old backup. Warn rather than silently saving plain text.
	 */
	private async checkEncryptionExpected(): Promise<void> {
		if (this.store.encrypted) {
			if (!this.settings.encryptionExpected) {
				// Encrypted before this setting existed: start tracking it.
				this.settings.encryptionExpected = true;
				await this.saveData(this.settings);
			}
			return;
		}
		if (!this.settings.encryptionExpected) return;
		new Notice(
			"Email Task Tracker: encryption was on, but records.json is now unencrypted or missing. If you didn't turn encryption off, " +
				"the file may have been replaced (e.g. by a sync conflict). New data is saved unencrypted until you check Settings → Encryption.",
			0,
		);
	}

	onunload(): void {
		this.stopDropFolderWatch();
	}

	pluginDir(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	/** records.json, written via a temp file so a crash mid-write can't corrupt it. */
	private recordsFile(): Persistence {
		const adapter = this.app.vault.adapter;
		const path = normalizePath(`${this.pluginDir()}/records.json`);
		const tmp = `${path}.tmp`;
		return {
			load: async () => {
				if (await adapter.exists(path)) return adapter.read(path);
				if (await adapter.exists(tmp)) return adapter.read(tmp);
				return null;
			},
			save: async (data) => {
				await adapter.write(tmp, data);
				if (await adapter.exists(path)) await adapter.remove(path);
				await adapter.rename(tmp, path);
			},
			backup: async () => {
				const source = (await adapter.exists(path)) ? path : (await adapter.exists(tmp)) ? tmp : null;
				if (!source) return null;
				const copy = normalizePath(`${this.pluginDir()}/records.backup-${Date.now()}.json`);
				await adapter.copy(source, copy);
				return copy;
			},
		};
	}

	/** Returns v1 categories found in data.json, if any, for migration. */
	async loadSettings(): Promise<unknown[]> {
		const raw: unknown = await this.loadData();
		this.settings = normalizeSettings(raw);
		const categories = isObject(raw) ? raw.categories : undefined;
		return Array.isArray(categories) ? (categories as unknown[]) : [];
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.store.notify("settings");
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	openSettings(): void {
		// The settings API isn't in the public typings, but is stable and widely used.
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	// ── Lock ────────────────────────────────────────────────────────────────

	/** Prompt for the passphrase if needed. Resolves false if the user cancels. */
	ensureUnlocked(): Promise<boolean> {
		if (!this.store.locked) return Promise.resolve(true);
		if (this.unlockPrompt) return this.unlockPrompt;
		this.unlockPrompt = new Promise<boolean>((resolve) => {
			const unlocked = () => {
				this.lastActivity = Date.now();
				this.reportStoreProblem();
				resolve(true);
			};
			const withRecoveryKey = () =>
				new PassphraseModal(
					this.app,
					"recovery",
					async (key) => {
						await this.store.unlockWithRecoveryKey(key);
						unlocked();
						this.promptNewPassphrase();
					},
					() => resolve(false),
				).open();
			new PassphraseModal(
				this.app,
				"unlock",
				async (pass) => {
					await this.store.unlock(pass);
					unlocked();
					if (this.store.upgradedWithoutRecovery) {
						new Notice("Your encrypted tracker was upgraded. Create a recovery key in the encryption settings so a forgotten passphrase isn't fatal.", 12000);
					}
				},
				() => resolve(false),
				{ onUseRecoveryKey: this.store.hasRecoveryKey ? withRecoveryKey : undefined },
			).open();
		}).finally(() => (this.unlockPrompt = null));
		return this.unlockPrompt;
	}

	/** After unlocking with the recovery key, set a new passphrase (the old one is unknown). */
	private promptNewPassphrase(): void {
		new PassphraseModal(
			this.app,
			"set",
			async (pass) => {
				await this.store.changePassphrase(pass);
				new Notice("New passphrase saved. Your recovery key still works.");
			},
			() => new Notice("Passphrase unchanged. You can set a new one in the encryption settings."),
			{ submitLabel: "Save new passphrase", intro: "You unlocked with your recovery key. Choose a new passphrase for next time." },
		).open();
	}

	/** Only reports "locked" once the data is really encrypted on disk and gone from memory. */
	async lock(): Promise<boolean> {
		try {
			if (await this.store.lock()) {
				new Notice("Email tracker locked.");
				return true;
			}
			new Notice("Couldn't lock the email tracker: encryption isn't set up. Check the encryption settings.");
		} catch {
			new Notice("Couldn't lock the email tracker: saving the encrypted file failed. It is still unlocked.");
		}
		return false;
	}

	private async checkIdle(): Promise<void> {
		const mins = this.settings.autoLockMinutes;
		if (!mins || !this.store.encrypted || this.store.locked) return;
		if (Date.now() - this.lastActivity < mins * 60_000) return;
		// On failure, wait a full period before trying (and notifying) again.
		if (!(await this.lock())) this.lastActivity = Date.now();
	}

	// ── Import ──────────────────────────────────────────────────────────────

	private onWindowDrop(evt: DragEvent): void {
		const dt = evt.dataTransfer;
		if (!dt) return;
		const files = Array.from(dt.files);
		if (this.settings.dropDiagnostics) {
			const summary = files.map((f) => `${f.name} (${f.type || "no type"}, ${f.size} bytes)`).join("\n");
			new Notice(`Drop received\nTypes: ${Array.from(dt.types).join(", ") || "none"}\nFiles: ${summary || "none"}`, 15000);
		}
		const emails = files.filter((f) => isEmailFileName(f.name) || EMAIL_MIME_TYPES.has(f.type));
		if (!emails.length) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		if (emails.length < files.length) new Notice("Only the email files were imported. Drop other files separately.");
		void this.importItems(emails.map((f) => ({ name: f.name, size: f.size, read: () => f.arrayBuffer() })));
	}

	pickFiles(): void {
		const input = createEl("input", { type: "file" });
		input.multiple = true;
		input.accept = ".eml,.msg";
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			void this.importItems(files.map((f) => ({ name: f.name, size: f.size, read: () => f.arrayBuffer() })));
		});
		input.click();
	}

	async importItems(items: ImportItem[]): Promise<ImportOutcome[]> {
		if (!(await this.ensureUnlocked())) {
			new Notice("Import cancelled: the tracker is locked.");
			return items.map(() => "failed");
		}
		const outcomes: ImportOutcome[] = [];
		const perCategory = new Map<string, number>();
		for (const item of items) outcomes.push(await this.importOne(item, perCategory));
		if (outcomes.includes("added")) await this.store.save();

		const added = outcomes.filter((o) => o === "added").length;
		const dup = outcomes.filter((o) => o === "duplicate").length;
		const failed = outcomes.filter((o) => o === "failed").length;
		const lines = [`Imported ${added} email${added === 1 ? "" : "s"}`];
		for (const [label, n] of perCategory) lines.push(`  ${label}: ${n}`);
		if (dup) lines.push(`Skipped ${dup} already tracked`);
		if (failed) lines.push(`Could not read ${failed} file${failed === 1 ? "" : "s"}`);
		new Notice(lines.join("\n"), 8000);
		return outcomes;
	}

	private async importOne(item: ImportItem, perCategory: Map<string, number>): Promise<ImportOutcome> {
		try {
			if (item.size !== undefined && (item.size === 0 || item.size > MAX_EMAIL_BYTES)) return "failed";
			const data = await item.read();
			if (data.byteLength === 0 || data.byteLength > MAX_EMAIL_BYTES) return "failed";
			const parsed = await parseEmail(data);
			if (this.store.hasFingerprint(fingerprintOf(parsed))) return "duplicate";
			const result = classify(this.categories, {
				subject: parsed.subject,
				body: parsed.body,
				fromAddress: parsed.fromAddress,
				fromName: parsed.fromName,
			});
			this.store.records.push(buildRecord(parsed, result, this.settings, this.categories));
			const labels = result.paths.length ? result.paths.map((p) => pathLabel(this.categories, p)) : ["Uncategorized"];
			for (const label of labels) perCategory.set(label, (perCategory.get(label) ?? 0) + 1);
			return "added";
		} catch (err) {
			// Log the error type only; messages from parsers can quote email content.
			console.error("Email Task Tracker: could not parse a file", (err as Error)?.name ?? "Error");
			return "failed";
		}
	}

	// ── Drop folder ─────────────────────────────────────────────────────────

	/** Returns an error message if the folder can't be used, otherwise null. */
	validateDropFolder(dir: string): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return "Drop folders need the desktop app.";
		const target = resolve(dir).toLowerCase() + sep;
		const vault = resolve(adapter.getBasePath()).toLowerCase() + sep;
		if (target.startsWith(vault)) return "Choose a folder outside the vault, so email files never sit inside it.";
		return null;
	}

	startDropFolderWatch(): void {
		this.stopDropFolderWatch();
		const dir = this.settings.dropFolder.trim();
		if (!dir) return;
		const problem = this.validateDropFolder(dir);
		if (problem) {
			new Notice(`Email Task Tracker drop folder is off: ${problem}`);
			return;
		}
		try {
			this.watcher = watch(dir, () => {
				if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
				this.scanTimer = window.setTimeout(() => void this.scanDropFolder(true), 1500);
			});
			this.watcher.on("error", () => this.stopDropFolderWatch());
		} catch {
			new Notice("Couldn't watch the drop folder. Check that it exists.");
			return;
		}
		void this.scanDropFolder(true);
	}

	stopDropFolderWatch(): void {
		this.watcher?.close();
		this.watcher = null;
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
		this.scanTimer = null;
	}

	async scanDropFolder(quietIfEmpty = false): Promise<void> {
		const dir = this.settings.dropFolder.trim();
		if (!dir) {
			if (!quietIfEmpty) new Notice("Set a drop folder in the plugin settings first.");
			return;
		}
		const problem = this.validateDropFolder(dir);
		if (problem) {
			new Notice(problem);
			return;
		}
		let names: string[];
		try {
			names = (await readdir(dir)).filter(isEmailFileName);
		} catch {
			new Notice("Could not read the drop folder.");
			return;
		}
		const fresh = names.filter((n) => !this.seenInDropFolder.has(n));
		if (!fresh.length) {
			if (!quietIfEmpty) new Notice("No new email files in the drop folder.");
			return;
		}
		// Waits for unlock if needed; files stay where they are until then.
		if (!(await this.ensureUnlocked())) return;
		const items = fresh.map((name) => ({
			name,
			read: async () => {
				const path = join(dir, name);
				// Check the size first, so a huge file can't stall Obsidian while it loads.
				if ((await stat(path)).size > MAX_EMAIL_BYTES) throw new RangeError("File too large");
				const buf = await readFile(path);
				return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			},
		}));
		const outcomes = await this.importItems(items);
		for (let i = 0; i < fresh.length; i++) {
			if (outcomes[i] === "failed") continue;
			this.seenInDropFolder.add(fresh[i]);
			if (this.settings.deleteAfterImport) {
				await unlink(join(dir, fresh[i])).catch(() => new Notice(`Could not delete ${fresh[i]}`));
				this.seenInDropFolder.delete(fresh[i]);
			}
		}
	}

	// ── Categories ──────────────────────────────────────────────────────────

	/** Replace the whole category list in one step, then re-sort automatically placed records once. */
	async saveCategories(next: Category[]): Promise<number> {
		this.store.categories = next;
		const moved = reclassify(this.store.records, next);
		await this.store.save();
		return moved;
	}

	/** Set a task's status by hand, or pass null to go back to automatic. */
	async setTaskOverride(id: string, status: TaskStatus | null): Promise<void> {
		const cat = this.store.categories.find((c) => c.id === id);
		if (!cat) return;
		cat.override = status ? { status, at: new Date().toISOString() } : undefined;
		await this.store.save();
	}

	async setTaskDue(id: string, due: string | undefined): Promise<void> {
		const cat = this.store.categories.find((c) => c.id === id);
		if (!cat) return;
		cat.due = due;
		await this.store.save();
	}

	async deleteCategory(id: string): Promise<void> {
		this.store.categories = deleteCategory(this.store.categories, this.store.records, id);
		reclassify(this.store.records, this.store.categories);
		await this.store.save();
	}

	async removeFromParent(id: string, parentId: string): Promise<void> {
		this.store.categories = removeFromParent(this.store.categories, this.store.records, id, parentId);
		reclassify(this.store.records, this.store.categories);
		await this.store.save();
	}

	async rerunFilters(): Promise<void> {
		if (!(await this.ensureUnlocked())) return;
		const moved = reclassify(this.store.records, this.categories);
		await this.store.save();
		new Notice(`Re-sorted ${moved} email${moved === 1 ? "" : "s"}. Emails you placed by hand were left alone.`);
	}

	// ── Data ────────────────────────────────────────────────────────────────

	async exportCsv(): Promise<void> {
		if (!(await this.ensureUnlocked())) return;
		const write = async () => {
			const csv = toCsv(this.store.records, this.categories);
			const base = `Email tracker export ${localIsoDate(new Date())}`;
			let path = `${base}.csv`;
			for (let n = 2; await this.app.vault.adapter.exists(path); n++) path = `${base} (${n}).csv`;
			await this.app.vault.create(path, csv);
			new Notice(`Exported ${this.store.records.length} records to "${path}". This file is not encrypted: delete it when you no longer need it.`, 10000);
		};
		if (!this.store.encrypted) return write();
		new ConfirmModal(
			this.app,
			"Export without encryption?",
			"Your tracker is encrypted, but the CSV file will be plain text in the vault root. Delete it when you're done with it.",
			"Export",
			write,
		).open();
	}

	async confirmPurge(): Promise<void> {
		if (!(await this.ensureUnlocked())) return;
		new ConfirmModal(
			this.app,
			"Delete all records?",
			`This permanently removes all ${this.store.records.length} tracked email records. Your categories and filters are kept.`,
			"Delete all",
			async () => {
				this.store.purge();
				await this.store.save();
				new Notice("All records deleted.");
			},
		).open();
	}
}
