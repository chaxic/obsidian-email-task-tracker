import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type EmailTrackerPlugin from "../main";
import type { Category } from "../types";
import { childrenOf } from "../classify/engine";
import { CategoryModal } from "./CategoryModal";
import { PassphraseModal } from "./PassphraseModal";
import { RecoveryKeyModal } from "./RecoveryKeyModal";
import { taskIcon } from "./icons";
import { swatch } from "./charts";
import { confirmDeleteCategory, openCategoryMenu } from "./categoryActions";

export class TrackerSettingTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, private plugin: EmailTrackerPlugin) {
		super(app, plugin);
	}

	hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	display(): void {
		// Subscribe once while the tab is shown; redraws must not re-subscribe.
		this.unsubscribe ??= this.plugin.store.onChange((reason) => {
			if (reason !== "settings") this.display();
		});
		const { containerEl } = this;
		containerEl.empty();
		this.renderCategories(containerEl);
		this.renderPrivacy(containerEl);
		this.renderEncryption(containerEl);
		this.renderDropFolder(containerEl);
		this.renderData(containerEl);
	}

	private renderCategories(el: HTMLElement): void {
		const store = this.plugin.store;
		const heading = new Setting(el).setName("Categories").setHeading();
		if (store.locked) {
			heading.addButton((b) => b.setButtonText("Unlock to manage").onClick(() => void this.plugin.ensureUnlocked()));
			el.createDiv({ cls: "ett-muted ett-note", text: "Categories and filters are encrypted. Unlock to see them." });
			return;
		}
		heading.addButton((b) =>
			b
				.setButtonText("Add category")
				.setCta()
				.onClick(() => new CategoryModal(this.plugin, { parentId: null }).open()),
		);
		const cats = this.plugin.categories;
		const tree = el.createDiv({ cls: "ett-cat-tree" });
		if (!cats.length) {
			tree.createDiv({ cls: "ett-muted", text: "No categories yet. Every imported email goes to Uncategorized until you add one." });
			return;
		}
		tree.createDiv({
			cls: "ett-muted ett-note",
			text: "A category ticked under several parents appears under each of them. Right-click a row for more options.",
		});
		const count = (id: string) => store.records.filter((r) => r.paths.some((p) => p.includes(id))).length;
		const walk = (parentId: string | null, depth: number, chain: string[]) => {
			for (const c of childrenOf(cats, parentId)) {
				if (chain.includes(c.id)) continue;
				this.categoryRow(tree, c, parentId, depth, count(c.id));
				walk(c.id, depth + 1, [...chain, c.id]);
			}
		};
		walk(null, 0, []);
	}

	private categoryRow(tree: HTMLElement, c: Category, parentId: string | null, depth: number, emails: number): void {
		const rule = c.rule;
		const parts = [
			rule.anyOf.length && `any of ${rule.anyOf.length} keywords`,
			rule.allOf.length && `all of ${rule.allOf.length}`,
			rule.noneOf.length && `${rule.noneOf.length} excluded`,
			rule.senders.length && `${rule.senders.length} senders`,
			rule.domains.length && `${rule.domains.length} domains`,
		].filter(Boolean);
		const extras = [c.trackAsTask && "task", c.parentIds.length > 1 && `shared by ${c.parentIds.length} parents`].filter(Boolean);
		const row = new Setting(tree)
			.setName(c.name)
			.setDesc([`${emails} emails`, parts.join(", ") || "group (no filter)", ...extras].join(" · "))
			.addExtraButton((b) =>
				b
					.setIcon("plus")
					.setTooltip("Add child category")
					.onClick(() => new CategoryModal(this.plugin, { parentId: c.id }).open()),
			)
			.addExtraButton((b) =>
				b
					.setIcon("pencil")
					.setTooltip("Edit")
					.onClick(() => new CategoryModal(this.plugin, { category: c }).open()),
			)
			.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip("Delete")
					.onClick(() => confirmDeleteCategory(this.plugin, c)),
			);
		row.settingEl.addClass("ett-setting-nested");
		row.settingEl.setCssProps({ "--ett-depth": String(depth) });
		row.settingEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openCategoryMenu(e, this.plugin, c, parentId);
		});
		row.nameEl.prepend(swatch(row.nameEl, c.color));
		taskIcon(row.nameEl, c);
	}

	private renderPrivacy(el: HTMLElement): void {
		const s = this.plugin.settings;
		new Setting(el).setName("Privacy and storage").setHeading();
		el.createDiv({
			cls: "ett-muted ett-note",
			text:
				"Email bodies, recipients and attachments are never saved, and the plugin never connects to the internet. " +
				`Categories and records are stored in ${this.plugin.pluginDir()}/records.json inside this vault.`,
		});

		new Setting(el)
			.setName("Store subject lines")
			.setDesc("Helps you find the original email. Turn off to keep only sender, date and keywords for new imports.")
			.addToggle((t) =>
				t.setValue(s.storeSubject).onChange(async (v) => {
					s.storeSubject = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(el)
			.setName("Keywords kept per email")
			.setDesc("Single words (no numbers) used to re-run filters on past emails. Set to zero to keep none.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 50, 1)
					.setValue(s.keywordCount)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.keywordCount = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName("Gmail search links")
			.setDesc("Adds a button that opens Gmail in your browser, searching for the email by its message ID. Only opens when you click it.")
			.addToggle((t) =>
				t.setValue(s.gmailLinks).onChange(async (v) => {
					s.gmailLinks = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	private renderEncryption(el: HTMLElement): void {
		const store = this.plugin.store;
		const s = this.plugin.settings;
		new Setting(el).setName("Encryption").setHeading();
		el.createDiv({
			cls: "ett-muted ett-note",
			text:
				"Encrypts records.json, including your categories and filters (AES-256-GCM). Explorer can still see the file, " +
				"but its contents are unreadable without your passphrase or recovery key. You unlock once per session.",
		});

		if (!store.encrypted) {
			if (s.encryptionExpected) {
				new Setting(el)
					.setName("Encryption was on")
					.setDesc(
						"records.json is now unencrypted or missing. If you didn't turn encryption off, the file may have been " +
							"replaced, e.g. by a sync conflict or an old backup. Restore it, or turn encryption on again below.",
					)
					.addButton((b) =>
						b.setButtonText("Keep it off").onClick(async () => {
							s.encryptionExpected = false;
							await this.plugin.saveSettings();
							this.display();
						}),
					)
					.descEl.addClass("ett-warning-text");
			}
			new Setting(el)
				.setName("Encrypt tracker data")
				.setDesc("Off. Data is stored as plain JSON.")
				.addButton((b) =>
					b
						.setButtonText("Turn on…")
						.setCta()
						.onClick(() =>
							new PassphraseModal(
								this.app,
								"set",
								async (pass) => {
									const recoveryKey = await store.enableEncryption(pass);
									s.encryptionExpected = true;
									await this.plugin.saveSettings();
									new Notice("Encryption is on.");
									new RecoveryKeyModal(this.app, recoveryKey).open();
								},
								undefined,
								{ submitLabel: "Turn on encryption" },
							).open(),
						),
				);
			return;
		}

		new Setting(el)
			.setName("Status")
			.setDesc(store.locked ? "Encrypted and locked." : "Encrypted and unlocked for this session.")
			.addButton((b) =>
				store.locked
					? b.setButtonText("Unlock").setCta().onClick(() => void this.plugin.ensureUnlocked())
					: b.setButtonText("Lock now").onClick(() => void this.plugin.lock()),
			);

		new Setting(el)
			.setName("Lock automatically")
			.setDesc("After this long without using Obsidian.")
			.addDropdown((dd) =>
				dd
					.addOptions({ "0": "Never", "15": "15 minutes", "30": "30 minutes", "60": "1 hour" })
					.setValue(String(s.autoLockMinutes))
					.onChange(async (v) => {
						s.autoLockMinutes = Number(v);
						await this.plugin.saveSettings();
					}),
			);

		const created = store.recoveryKeyCreatedAt;
		const recovery = new Setting(el)
			.setName("Recovery key")
			.setDesc(
				created
					? `Created ${new Date(created).toLocaleDateString()}. Use it if you forget your passphrase. If you lose both, the data can't be recovered.`
					: "Not set. Without one, a forgotten passphrase means the data is gone.",
			);
		if (!created) recovery.descEl.addClass("ett-warning-text");

		if (store.locked) return;

		recovery.addButton((b) => {
			b.setButtonText(created ? "Create new key…" : "Create recovery key…").onClick(() =>
				this.confirmSecret(
					created
						? "Your current recovery key will stop working. Your passphrase is unchanged."
						: "A recovery key unlocks your tracker if you forget your passphrase.",
					created ? "Create new key" : "Create recovery key",
					async () => new RecoveryKeyModal(this.app, await store.regenerateRecoveryKey()).open(),
				),
			);
			if (!created) b.setCta();
		});

		new Setting(el).setName("Change passphrase").setDesc("Your recovery key keeps working.").addButton((b) =>
			b.setButtonText("Change…").onClick(() =>
				this.confirmSecret("Confirm it's you before choosing a new passphrase.", "Continue", () =>
					new PassphraseModal(
						this.app,
						"set",
						async (pass) => {
							await store.changePassphrase(pass);
							new Notice("Passphrase changed.");
						},
						undefined,
						{ submitLabel: "Change passphrase" },
					).open(),
				),
			),
		);

		new Setting(el)
			.setName("Turn off encryption")
			.setDesc("Rewrites the data as plain JSON.")
			.addButton((b) =>
				b
					.setButtonText("Turn off…")
					.setWarning()
					.onClick(() =>
						this.confirmSecret(
							"Your categories, filters and email references will be saved as plain text in the vault.",
							"Turn off encryption",
							async () => {
								await store.disableEncryption();
								s.encryptionExpected = false;
								await this.plugin.saveSettings();
								new Notice("Encryption is off.");
							},
						),
					),
			);
	}

	/**
	 * Sensitive changes need the current passphrase (or recovery key), not just an unlocked
	 * session, so someone at an unattended computer can't, say, mint their own recovery key.
	 */
	private confirmSecret(intro: string, submitLabel: string, then: () => void | Promise<void>): void {
		new PassphraseModal(
			this.app,
			"confirm",
			async (secret) => {
				await this.plugin.store.confirmSecret(secret);
				await then();
			},
			undefined,
			{ intro: `${intro} Enter your passphrase (or recovery key) to continue.`, submitLabel },
		).open();
	}

	private renderDropFolder(el: HTMLElement): void {
		const s = this.plugin.settings;
		new Setting(el).setName("Drop folder").setHeading();
		new Setting(el)
			.setName("Folder to watch")
			.setDesc("Optional. Save or drag emails into this folder (outside the vault) and they are imported automatically.")
			.addText((t) =>
				t
					.setPlaceholder("Full path to a folder outside the vault")
					.setValue(s.dropFolder)
					.onChange((v) => (s.dropFolder = v.trim())),
			)
			.addButton((b) =>
				b.setButtonText("Apply").onClick(async () => {
					const problem = s.dropFolder ? this.plugin.validateDropFolder(s.dropFolder) : null;
					if (problem) {
						new Notice(problem);
						return;
					}
					await this.plugin.saveSettings();
					this.plugin.startDropFolderWatch();
					new Notice(s.dropFolder ? "Watching the drop folder." : "Drop folder turned off.");
				}),
			);

		new Setting(el)
			.setName("Delete files after import")
			.setDesc("Permanently deletes each email file from the drop folder once it's tracked, so copies don't pile up.")
			.addToggle((t) =>
				t.setValue(s.deleteAfterImport).onChange(async (v) => {
					s.deleteAfterImport = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	private renderData(el: HTMLElement): void {
		const s = this.plugin.settings;
		new Setting(el).setName("Data").setHeading();
		new Setting(el)
			.setName("Drop diagnostics")
			.setDesc("Shows the file names, types and sizes a drop contains. Useful if dragging from Outlook doesn't work.")
			.addToggle((t) =>
				t.setValue(s.dropDiagnostics).onChange(async (v) => {
					s.dropDiagnostics = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(el)
			.setName("Export to CSV")
			.setDesc("Writes all records to a CSV file in the vault root.")
			.addButton((b) => b.setButtonText("Export").onClick(() => void this.plugin.exportCsv()));
		new Setting(el)
			.setName("Delete all records")
			.setDesc(this.plugin.store.locked ? "Unlock first." : `Removes all ${this.plugin.store.records.length} tracked emails. Categories are kept.`)
			.addButton((b) =>
				b
					.setButtonText("Delete all")
					.setWarning()
					.onClick(() => void this.plugin.confirmPurge()),
			);
	}
}
