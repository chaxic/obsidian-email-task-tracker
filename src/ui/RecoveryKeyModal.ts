import { App, Modal, Notice, Setting } from "obsidian";

/** Shows a new recovery key once. It is never stored in readable form. */
export class RecoveryKeyModal extends Modal {
	constructor(app: App, private recoveryKey: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Your recovery key");
		contentEl.createEl("p", {
			text:
				"If you forget your passphrase, this key unlocks your tracker and lets you set a new one. " +
				"It's shown only now. Store it in a password manager or print it, and keep it away from this computer.",
		});
		contentEl.createDiv({ cls: "ett-recovery-key", text: this.recoveryKey });
		contentEl.createEl("p", {
			cls: "ett-muted",
			text: "Anyone with this key can unlock your tracker. If you lose both the key and your passphrase, the data can't be recovered.",
		});

		let done!: import("obsidian").ButtonComponent;
		const confirm = contentEl.createEl("label", { cls: "ett-parent-option ett-confirm" });
		const box = confirm.createEl("input", { type: "checkbox" });
		confirm.createSpan({ text: "I've stored my recovery key safely" });
		box.addEventListener("change", () => {
			done.setDisabled(!box.checked);
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Copy").onClick(() => {
					void navigator.clipboard
						.writeText(this.recoveryKey)
						.then(() => new Notice("Recovery key copied. Paste it into your password manager, then clear your clipboard."));
				}),
			)
			.addButton((b) => {
				done = b;
				b.setButtonText("Done")
					.setCta()
					.setDisabled(true)
					.onClick(() => this.close());
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
