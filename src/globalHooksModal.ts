import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import type GhostwriterPlugin from "./main";
import { HookItem, makeModeId } from "./settings";

class HookFileSuggest extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("Pick a note to inject into every prompt…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

/**
 * Manage the global-hook list: notes pinned into every completion prompt. Each
 * item can follow the active context strategy or override it, and can be capped
 * or reordered per note.
 */
export class GlobalHooksModal extends Modal {
  private plugin: GhostwriterPlugin;

  constructor(app: App, plugin: GhostwriterPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private render(): void {
    const { modalEl, titleEl, contentEl } = this;
    modalEl.addClass("ghostwriter-hooks-modal");
    titleEl.setText("Global context hooks");
    contentEl.empty();

    const s = this.plugin.settings;

    new Setting(contentEl)
      .setName("Enable global hooks")
      .setDesc("When on, every enabled note below is injected into each completion prompt.")
      .addToggle((toggle) =>
        toggle.setValue(s.globalHooksEnabled).onChange(async (value) => {
          s.globalHooksEnabled = value;
          await this.save();
        })
      );

    new Setting(contentEl)
      .setName("Add note")
      .setDesc("Pin another note (not necessarily the current one) into every prompt.")
      .addButton((btn) => {
        btn
          .setButtonText("Pick note…")
          .setCta()
          .onClick(() => {
            new HookFileSuggest(this.app, async (file) => {
              if (s.globalHooks.some((h) => h.path === file.path)) {
                new Notice("That note is already a global hook");
                return;
              }
              s.globalHooks.push({
                id: makeModeId(),
                path: file.path,
                enabled: true,
                contextMode: "follow",
                maxChars: 0,
              });
              await this.save();
              this.render();
            }).open();
          });
      });

    if (!s.globalHooks.length) {
      contentEl.createEl("p", {
        text: "No hooks yet. Add a note to pin it into every prompt.",
        cls: "setting-item-description",
      });
      return;
    }

    s.globalHooks.forEach((hook, idx) => {
      const file = this.app.vault.getAbstractFileByPath(hook.path);
      const missing = !(file instanceof TFile);
      const title = file instanceof TFile ? file.basename : hook.path.split("/").pop() ?? hook.path;

      new Setting(contentEl)
        .setName(`${idx + 1}. ${title}${missing ? " (missing)" : ""}`)
        .setDesc(hook.path)
        .addToggle((toggle) =>
          toggle
            .setTooltip("Inject this note")
            .setValue(hook.enabled)
            .onChange(async (value) => {
              hook.enabled = value;
              await this.save();
            })
        )
        .addDropdown((dd) => {
          dd.addOptions({
            follow: "follow mode",
            window: "window",
            full: "full",
            "in-note": "in-note",
          });
          dd.setValue(hook.contextMode);
          dd.onChange(async (value) => {
            hook.contextMode = value as HookItem["contextMode"];
            await this.save();
          });
        })
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.setPlaceholder("0 = mode default");
          text.setValue(String(hook.maxChars));
          text.onChange(async (value) => {
            const n = Math.floor(Number(value));
            hook.maxChars = Number.isFinite(n) && n > 0 ? n : 0;
            await this.save();
          });
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("arrow-up")
            .setTooltip("Move up")
            .onClick(async () => {
              if (idx <= 0) return;
              [s.globalHooks[idx - 1], s.globalHooks[idx]] = [s.globalHooks[idx], s.globalHooks[idx - 1]];
              await this.save();
              this.render();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("arrow-down")
            .setTooltip("Move down")
            .onClick(async () => {
              if (idx >= s.globalHooks.length - 1) return;
              [s.globalHooks[idx + 1], s.globalHooks[idx]] = [s.globalHooks[idx], s.globalHooks[idx + 1]];
              await this.save();
              this.render();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove this hook")
            .onClick(async () => {
              s.globalHooks.splice(idx, 1);
              await this.save();
              this.render();
            })
        )
        .settingEl.addClass("ghostwriter-hook-row");
    });
  }
}
