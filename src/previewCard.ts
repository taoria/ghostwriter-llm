import { App, Modal } from "obsidian";
import { CacheUsage, formatCacheUsage } from "./completionService";

export interface PromptMessage {
  role: string;
  content: string;
}

export interface PreviewCallbacks {
  onAccept: (completion: string) => void;
  onReject: () => void;
}

export class PreviewCard extends Modal {
  private thinkingEl: HTMLElement | null = null;
  private thinkingBody: HTMLElement | null = null;
  private completionEl: HTMLElement | null = null;
  private cacheUsageEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private errorBodyEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private acceptBtn: HTMLButtonElement | null = null;
  private rejectBtn: HTMLButtonElement | null = null;
  private promptWrapEl: HTMLElement | null = null;
  private promptToggle: HTMLElement | null = null;
  private promptBodyEl: HTMLElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private cb: PreviewCallbacks;
  private completion: string = "";
  private thinking: string = "";
  private finished: boolean = false;
  private hasThinking: boolean = false;
  private promptExpanded: boolean = false;
  private promptMessages: PromptMessage[] = [];
  private promptExtra: Record<string, unknown> = {};

  constructor(app: App, cb: PreviewCallbacks) {
    super(app);
    this.cb = cb;
  }

  setPromptPayload(messages: PromptMessage[], extra: Record<string, unknown>): void {
    this.promptMessages = messages;
    this.promptExtra = extra;
    if (this.promptBodyEl) this.renderPromptBody();
  }

  onOpen(): void {
    const { modalEl, titleEl, contentEl } = this;
    modalEl.addClass("llm-preview-modal");
    titleEl.setText("LLM Completion Preview");

    const status = contentEl.createDiv({ cls: "llm-preview-status" });
    status.setText("Generating…");
    status.createSpan({ cls: "llm-preview-spinner" });
    this.statusEl = status;

    const cacheUsage = contentEl.createDiv({ cls: "llm-preview-cache-usage" });
    cacheUsage.setText("Prompt cache: waiting for usage data");
    this.cacheUsageEl = cacheUsage;

    const errorSection = contentEl.createDiv({ cls: "llm-preview-section llm-preview-error" });
    errorSection.style.display = "none";
    errorSection.createDiv({ cls: "llm-preview-section-header" }).setText("Error");
    const errorBody = errorSection.createDiv({ cls: "llm-preview-section-body llm-preview-error-body" });
    const errorHint = errorSection.createDiv({ cls: "llm-preview-error-hint" });
    errorHint.setText("Full details are in the developer console (Ctrl+Shift+I / Cmd+Opt+I). Check the model, base URL, API key, and request size (recall level / adjacent notes) if this keeps happening.");
    this.errorEl = errorSection;
    this.errorBodyEl = errorBody;

    const promptWrap = contentEl.createDiv({ cls: "llm-preview-prompt-wrap" });
    const promptToggle = promptWrap.createDiv({ cls: "llm-preview-prompt-toggle" });
    promptToggle.setText("Show full prompt");
    const promptWrapInner = promptWrap.createDiv({ cls: "llm-preview-prompt-collapse" });
    promptWrapInner.style.display = "none";
    const promptBody = promptWrapInner.createDiv({ cls: "llm-preview-section-body llm-preview-prompt-body" });
    const promptActions = promptWrapInner.createDiv({ cls: "llm-preview-prompt-actions" });
    const copyBtn = promptActions.createEl("button", { cls: "llm-preview-copy-btn", text: "Copy prompt JSON" });
    copyBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const payload = JSON.stringify({
        ...this.promptExtra,
        messages: this.promptMessages,
      }, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        copyBtn.setText("Copied!");
        setTimeout(() => copyBtn.setText("Copy prompt JSON"), 1500);
      } catch {
        copyBtn.setText("Copy failed");
        setTimeout(() => copyBtn.setText("Copy prompt JSON"), 1500);
      }
    });
    promptToggle.addEventListener("click", (e) => {
      e.preventDefault();
      this.promptExpanded = !this.promptExpanded;
      promptWrapInner.style.display = this.promptExpanded ? "" : "none";
      promptToggle.setText(this.promptExpanded ? "Hide full prompt" : "Show full prompt");
      promptToggle.classList.toggle("is-expanded", this.promptExpanded);
    });
    this.promptWrapEl = promptWrap;
    this.promptToggle = promptToggle;
    this.promptBodyEl = promptBody;
    this.copyBtn = copyBtn;

    const thinkingSection = contentEl.createDiv({ cls: "llm-preview-section llm-preview-thinking" });
    thinkingSection.style.display = "none";
    const thinkingHeader = thinkingSection.createDiv({ cls: "llm-preview-section-header" });
    thinkingHeader.setText("Thinking");
    const thinkingBody = thinkingSection.createDiv({ cls: "llm-preview-section-body llm-preview-thinking-body" });
    this.thinkingEl = thinkingSection;
    this.thinkingBody = thinkingBody;

    const completionSection = contentEl.createDiv({ cls: "llm-preview-section llm-preview-completion" });
    const completionHeader = completionSection.createDiv({ cls: "llm-preview-section-header" });
    completionHeader.setText("Completion");
    const completionBody = completionSection.createDiv({ cls: "llm-preview-section-body llm-preview-completion-body" });
    this.completionEl = completionBody;

    const actions = contentEl.createDiv({ cls: "llm-preview-actions" });
    actions.style.display = "none";
    const acceptBtn = actions.createEl("button", { cls: "mod-cta llm-preview-accept", text: "Accept" });
    const rejectBtn = actions.createEl("button", { cls: "llm-preview-reject", text: "Reject" });
    acceptBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!this.finished) return;
      this.cb.onAccept(this.completion);
      this.close();
    });
    rejectBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.cb.onReject();
      this.close();
    });
    this.actionsEl = actions;
    this.acceptBtn = acceptBtn;
    this.rejectBtn = rejectBtn;

    if (this.promptMessages.length) this.renderPromptBody();
  }

  onClose(): void {
    if (!this.finished) {
      this.cb.onReject();
    }
  }

  appendThinking(delta: string): void {
    if (!delta || !this.thinkingBody) return;
    if (!this.hasThinking) {
      this.hasThinking = true;
      if (this.thinkingEl) this.thinkingEl.style.display = "";
    }
    this.thinking += delta;
    this.renderText(this.thinkingBody, this.thinking);
    this.scrollToBottom();
  }

  appendCompletion(delta: string): void {
    if (!delta || !this.completionEl) return;
    this.completion += delta;
    this.renderText(this.completionEl, this.completion);
    this.scrollToBottom();
  }

  restartCompletion(): void {
    this.completion = "";
    if (this.completionEl) this.renderText(this.completionEl, this.completion);
  }

  setCompletion(text: string): void {
    this.completion = text;
    if (this.completionEl) this.renderText(this.completionEl, text);
  }

  setCacheUsage(usage?: CacheUsage): void {
    if (!this.cacheUsageEl) return;
    this.cacheUsageEl.setText(usage ? `Prompt cache: ${formatCacheUsage(usage)}` : "Prompt cache: not reported by provider");
    this.cacheUsageEl.toggleClass("is-available", !!usage);
  }

  finish(): void {
    this.finished = true;
    if (this.statusEl) this.statusEl.style.display = "none";
    if (this.actionsEl) this.actionsEl.style.display = "";
  }

  showError(message: string): void {
    this.finished = true;
    if (this.statusEl) this.statusEl.style.display = "none";
    if (this.errorEl && this.errorBodyEl) {
      this.errorEl.style.display = "";
      this.errorBodyEl.setText(message);
    }
    if (this.actionsEl) this.actionsEl.style.display = "";
    if (this.acceptBtn) this.acceptBtn.disabled = true;
  }

  private renderPromptBody(): void {
    if (!this.promptBodyEl) return;
    this.promptBodyEl.empty();
    for (const m of this.promptMessages) {
      const row = this.promptBodyEl.createDiv({ cls: "llm-preview-prompt-row" });
      const roleBadge = row.createDiv({ cls: `llm-preview-prompt-role is-${m.role}` });
      roleBadge.setText(m.role);
      const content = row.createDiv({ cls: "llm-preview-prompt-content" });
      content.setText(m.content);
    }
    const metaRow = this.promptBodyEl.createDiv({ cls: "llm-preview-prompt-meta" });
    metaRow.setText(`model: ${this.promptExtra.model ?? ""} | max_tokens: ${this.promptExtra.max_tokens ?? ""} | temperature: ${this.promptExtra.temperature ?? ""} | stream: ${this.promptExtra.stream ?? ""} | messages: ${this.promptMessages.length}`);
  }

  private renderText(el: HTMLElement, text: string): void {
    el.empty();
    if (window.DOMPurify) {
      el.innerHTML = window.DOMPurify.sanitize(this.escapeHtml(text));
    } else {
      el.textContent = text;
    }
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private scrollToBottom(): void {
    const el = this.contentEl;
    el.scrollTop = el.scrollHeight;
  }
}

declare global {
  interface Window {
    DOMPurify?: { sanitize: (s: string) => string };
  }
}
