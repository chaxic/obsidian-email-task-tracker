import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private message: string,
		private confirmText: string,
		private onConfirm: () => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
