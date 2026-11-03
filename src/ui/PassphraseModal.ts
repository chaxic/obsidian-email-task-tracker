import { App, Modal, Setting, type ButtonComponent } from "obsidian";

/**
 * set = choose a new passphrase; unlock = enter it; recovery = enter the recovery key;
 * confirm = re-enter the current passphrase before a sensitive change.
 */
export type PassphraseMode = "set" | "unlock" | "recovery" | "confirm";

const MIN_LENGTH = 12;

export interface PassphraseOptions {
	/** Button text in "set" and "confirm" mode, e.g. "Turn on encryption" or "Change passphrase". */
	submitLabel?: string;
	/** Shown above the field in "set" and "confirm" mode. */
	intro?: string;
	/** Unlock mode: offers "Forgot passphrase?" and calls this instead of cancelling. */
	onUseRecoveryKey?: () => void;
}

/**
 * Ask for a passphrase or recovery key. `submit` runs with it and may throw to
 * show an error (e.g. wrong passphrase) without closing the dialog.
 */
export class PassphraseModal extends Modal {
	private done = false;

	constructor(
		app: App,
		private mode: PassphraseMode,
		private submit: (secret: string) => Promise<void>,
		private onCancel?: () => void,
		private options: PassphraseOptions = {},
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const mode = this.mode;
		const titles: Record<PassphraseMode, string> = {
			unlock: "Unlock email tracker",
			recovery: "Unlock with recovery key",
			set: "Set a passphrase",
			confirm: "Confirm your passphrase",
		};
		this.titleEl.setText(titles[mode]);
		if (mode === "set") {
			contentEl.createEl("p", {
				text: this.options.intro ?? `Use at least ${MIN_LENGTH} characters; a few unrelated words work well.`,
			});
		}
		if (mode === "confirm") {
			contentEl.createEl("p", { text: this.options.intro ?? "Enter your current passphrase to continue." });
		}
		if (mode === "recovery") {
			contentEl.createEl("p", { text: "Enter the recovery key you saved when you turned on encryption. Dashes and case don't matter." });
		}
		const fieldLabels: Record<PassphraseMode, string> = {
			unlock: "Passphrase",
			recovery: "Recovery key",
			set: "New passphrase",
			confirm: "Current passphrase",
		};
		const first = this.field(fieldLabels[mode], mode === "recovery");
		const second = mode === "set" ? this.field("Type it again", false) : null;
		const error = contentEl.createDiv({ cls: "ett-error" });

		const label =
			mode === "set"
				? (this.options.submitLabel ?? "Save passphrase")
				: mode === "confirm"
					? (this.options.submitLabel ?? "Continue")
					: "Unlock";
		let button!: ButtonComponent;
		let busy = false;
		const go = async () => {
			if (busy) return;
			error.setText("");
			const secret = first.value;
			if (mode === "set") {
				if (secret.length < MIN_LENGTH) return error.setText(`Use at least ${MIN_LENGTH} characters.`);
				if (secret !== second!.value) return error.setText("The two passphrases don't match.");
			}
			busy = true;
			button.setDisabled(true).setButtonText(mode === "set" ? "Saving…" : mode === "confirm" ? "Checking…" : "Unlocking…");
			try {
				await this.submit(secret);
				this.done = true;
				this.close();
			} catch (e) {
				const name = (e as Error).name;
				error.setText(
					name === "WrongPassphraseError"
						? mode === "recovery"
							? "That recovery key doesn't match."
							: "Wrong passphrase."
						: name === "UnsupportedVersionError"
							? "This file was saved by a newer version of Email Task Tracker. Update the plugin to open it."
							: "Something went wrong. Nothing was changed.",
				);
				button.setDisabled(false).setButtonText(label);
				busy = false;
			}
		};
		for (const input of [first, second]) {
			input?.addEventListener("keydown", (e) => {
				if (e.key === "Enter") void go();
			});
		}

		if (mode === "unlock" && this.options.onUseRecoveryKey) {
			const link = contentEl.createEl("a", { cls: "ett-link", text: "Forgot passphrase? Use your recovery key", href: "#" });
			link.addEventListener("click", (e) => {
				e.preventDefault();
				this.done = true; // switching dialogs, not cancelling
				this.close();
				this.options.onUseRecoveryKey!();
			});
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				button = b;
				b.setButtonText(label)
					.setCta()
					.onClick(() => void go());
			});
		window.setTimeout(() => first.focus(), 0);
	}

	private field(label: string, visible: boolean): HTMLInputElement {
		const s = new Setting(this.contentEl).setName(label);
		return s.controlEl.createEl("input", {
			type: visible ? "text" : "password",
			cls: visible ? "ett-recovery-input" : "",
			attr: { autocomplete: "off", spellcheck: "false" },
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.onCancel?.();
	}
}
