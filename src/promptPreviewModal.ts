import { App, Modal } from "obsidian";

export interface PromptPreviewPayload {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
}

export interface PromptPreviewCallbacks {
  /** User confirmed: issue the request. */
  onSend: () => void;
  /** User cancelled (button, Escape or close). */
  onCancel: () => void;
}

/**
 * Pre-send prompt preview: shows the fully assembled request (system/prompt/CoT
 * messages plus the active model settings) and requires an explicit Send.
 */
export class PromptPreviewModal extends Modal {
  private payload: PromptPreviewPayload;
  private cb: PromptPreviewCallbacks;
  private handled = false;

  constructor(app: App, payload: PromptPreviewPayload, cb: PromptPreviewCallbacks) {
    super(app);
    this.payload = payload;
    this.cb = cb;
  }

  onOpen(): void {
    const { modalEl, titleEl, contentEl } = this;
    modalEl.addClass("ghostwriter-prompt-preview");
    titleEl.setText("Prompt preview · send?");

    const meta = contentEl.createDiv({ cls: "ghostwriter-prompt-preview-meta" });
    meta.setText(
      `model: ${this.payload.model} | max_tokens: ${this.payload.max_tokens} | ` +
        `temperature: ${this.payload.temperature} | stream: ${this.payload.stream} | ` +
        `messages: ${this.payload.messages.length}`
    );

    const body = contentEl.createDiv({ cls: "ghostwriter-prompt-preview-body" });
    for (const m of this.payload.messages) {
      const row = body.createDiv({ cls: "ghostwriter-prompt-preview-row" });
      const role = row.createDiv({ cls: `ghostwriter-prompt-preview-role is-${m.role}` });
      role.setText(m.role);
      const pre = row.createEl("pre", { cls: "ghostwriter-prompt-preview-content" });
      pre.setText(m.content);
    }

    const actions = contentEl.createDiv({ cls: "ghostwriter-prompt-preview-actions" });
    const copy = actions.createEl("button", { text: "Copy JSON" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(this.payload, null, 2));
        copy.setText("Copied!");
        setTimeout(() => copy.setText("Copy JSON"), 1500);
      } catch {
        copy.setText("Copy failed");
        setTimeout(() => copy.setText("Copy JSON"), 1500);
      }
    });

    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.handled = true;
      this.close();
      this.cb.onCancel();
    });

    const send = actions.createEl("button", { cls: "mod-cta", text: "Send" });
    send.addEventListener("click", () => {
      this.handled = true;
      this.close();
      this.cb.onSend();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.handled) this.cb.onCancel();
  }
}
