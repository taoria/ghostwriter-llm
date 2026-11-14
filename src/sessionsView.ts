import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type GhostwriterPlugin from "./main";
import { CompletionSession, sessionElapsed } from "./sessions";

export const VIEW_TYPE_SESSIONS = "ghostwriter-sessions";

const STATUS_LABEL: Record<CompletionSession["status"], string> = {
  preparing: "preparing",
  running: "generating",
  done: "ready",
  error: "error",
  cancelled: "cancelled",
};

/** Right-sidebar session manager: live preview + actions for every completion, plus an instruction bar. */
export class SessionsView extends ItemView {
  private plugin: GhostwriterPlugin;
  /** Persisted <details> open state across re-renders. */
  private openDetails = new Set<string>();
  private listEl: HTMLElement | null = null;
  private runningEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private modelSelect: HTMLSelectElement | null = null;
  private sliderEl: HTMLInputElement | null = null;
  private sliderValueEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GhostwriterPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SESSIONS;
  }

  getDisplayText(): string {
    return "Ghostwriter sessions";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
    this.listEl = null;
    this.runningEl = null;
    this.inputEl = null;
    this.modelSelect = null;
    this.sliderEl = null;
    this.sliderValueEl = null;
  }

  /** Build the persistent chrome (header + instruction bar) once; streaming only refreshes the list. */
  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ghostwriter-sessions-view");

    const header = root.createDiv({ cls: "ghostwriter-sessions-header" });
    header.createSpan({ cls: "ghostwriter-sessions-title", text: "Background sessions" });
    this.runningEl = header.createSpan({ cls: "ghostwriter-sessions-running" });
    this.runningEl.style.display = "none";
    const clear = header.createEl("button", { cls: "ghostwriter-sessions-clear", text: "Clear finished" });
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      this.plugin.clearFinishedSessions();
    });

    this.listEl = root.createDiv({ cls: "ghostwriter-sessions-list" });

    // Instruction bar: the typed text is a one-shot instruction for the next
    // completion (same as the "completion with an instruction" command), not a chat.
    const composer = root.createDiv({ cls: "ghostwriter-sessions-composer" });

    const top = composer.createDiv({ cls: "ghostwriter-composer-top" });
    const modelWrap = top.createDiv({ cls: "ghostwriter-composer-model" });
    modelWrap.createSpan({ cls: "ghostwriter-composer-label", text: "Model" });
    const select = top.createEl("select", { cls: "ghostwriter-composer-select" });
    this.modelSelect = select;
    this.fillModelOptions();
    select.addEventListener("change", () => {
      void this.plugin.switchProvider(select.value);
    });

    const row = composer.createDiv({ cls: "ghostwriter-composer-row" });
    const input = row.createEl("input", {
      cls: "ghostwriter-composer-input",
      type: "text",
      attr: {
        placeholder: "Instruction for the next completion (not a chat)…",
        "aria-label": "Instruction for the next completion",
      },
    });
    this.inputEl = input;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    const send = row.createEl("button", { cls: "ghostwriter-composer-send", attr: { "aria-label": "Trigger completion with this instruction" } });
    setIcon(send, "send");
    send.addEventListener("click", (e) => {
      e.preventDefault();
      this.send();
    });

    // {max_words} slider: one-shot override for this instruction; the leftmost value
    // is the active mode's max_words, bounded by the configured min/max.
    const sliderRow = composer.createDiv({ cls: "ghostwriter-composer-slider" });
    sliderRow.createSpan({ cls: "ghostwriter-composer-label", text: "max_words" });
    const bounds = this.sliderBounds();
    const initial = this.defaultSliderValue();
    const slider = sliderRow.createEl("input", {
      cls: "ghostwriter-composer-range",
      type: "range",
      attr: {
        min: String(bounds.min),
        max: String(bounds.max),
        step: String(this.sliderStep()),
        "aria-label": "max_words for the next completion",
      },
    });
    slider.value = String(initial);
    this.sliderEl = slider;
    const valueEl = sliderRow.createSpan({ cls: "ghostwriter-composer-value", text: String(initial) });
    this.sliderValueEl = valueEl;
    slider.addEventListener("input", () => valueEl.setText(slider.value));
    const reset = sliderRow.createEl("button", {
      cls: "ghostwriter-composer-reset",
      text: "↺",
      attr: { "aria-label": "Reset to the mode default" },
    });
    reset.addEventListener("click", (e) => {
      e.preventDefault();
      const v = this.defaultSliderValue();
      slider.value = String(v);
      valueEl.setText(String(v));
    });

    composer.createDiv({
      cls: "ghostwriter-composer-hint",
      text: "One-shot instruction appended to the next completion. It does not start a conversation.",
    });
  }

  /** Snap increment for the slider (default 64). */
  private sliderStep(): number {
    return Math.max(1, Math.floor(this.plugin.settings.instructionWordsStep || 64));
  }

  /** Snap a raw value to the nearest step above the slider minimum. */
  private snapSliderValue(value: number, min: number, max: number): number {
    const step = this.sliderStep();
    const snapped = min + Math.round((value - min) / step) * step;
    return Math.min(max, Math.max(min, snapped));
  }

  /** Slider bounds: leftmost reaches the mode default, rightmost is the configured max. */
  private sliderBounds(): { min: number; max: number } {
    const s = this.plugin.settings;
    const modeDefault = Math.max(1, Math.floor(s.maxWords || 1));
    const configuredMin = Math.max(1, Math.floor(s.instructionWordsMin || 256));
    const min = Math.min(configuredMin, modeDefault);
    const max = Math.max(min + 1, Math.floor(s.instructionWordsMax || 4096));
    return { min, max };
  }

  /** The mode's configured max_words clamped and snapped into the sidebar slider range. */
  private defaultSliderValue(): number {
    const { min, max } = this.sliderBounds();
    const s = this.plugin.settings;
    return this.snapSliderValue(Math.floor(s.maxWords || min), min, max);
  }

  /** Keep slider min/max/step in sync with settings, snapping and clamping the value. */
  private syncSliderRange(): void {
    if (!this.sliderEl) return;
    const { min, max } = this.sliderBounds();
    const step = this.sliderStep();
    if (this.sliderEl.min !== String(min)) this.sliderEl.min = String(min);
    if (this.sliderEl.max !== String(max)) this.sliderEl.max = String(max);
    if (this.sliderEl.step !== String(step)) this.sliderEl.step = String(step);
    const cur = Math.floor(Number(this.sliderEl.value) || min);
    const clamped = this.snapSliderValue(cur, min, max);
    if (String(clamped) !== this.sliderEl.value) {
      this.sliderEl.value = String(clamped);
      this.sliderValueEl?.setText(String(clamped));
    }
  }

  private fillModelOptions(): void {
    if (!this.modelSelect) return;
    const s = this.plugin.settings;
    this.modelSelect.empty();
    for (const p of s.providers) {
      const option = this.modelSelect.createEl("option", {
        text: `${p.name || p.id} · ${p.model || "?"}`,
      });
      option.value = p.id;
      if (p.id === s.activeProviderId) option.selected = true;
    }
  }

  private send(): void {
    if (!this.inputEl) return;
    const instruction = this.inputEl.value.trim();
    if (!instruction) return;
    const maxWords = this.sliderEl ? Number(this.sliderEl.value) : undefined;
    const ok = this.plugin.triggerInstruction(instruction, maxWords);
    if (ok) {
      this.inputEl.value = "";
      this.inputEl.focus();
    }
  }

  /** Re-render only the session list and the running badge; the instruction bar keeps focus/value. */
  render(): void {
    if (!this.listEl) {
      this.buildLayout();
    }
    const list = this.listEl;
    if (!list) return;
    const sessions = this.plugin.getSessions();
    const running = sessions.filter((s) => s.status === "running" || s.status === "preparing").length;
    if (this.runningEl) {
      this.runningEl.style.display = running ? "" : "none";
      this.runningEl.setText(`${running} running`);
    }
    // The provider list may have changed in settings; keep the selector fresh.
    if (this.modelSelect) {
      const active = this.plugin.settings.activeProviderId;
      if (
        this.modelSelect.value !== active ||
        this.modelSelect.options.length !== this.plugin.settings.providers.length
      ) {
        this.fillModelOptions();
      }
    }
    this.syncSliderRange();

    list.empty();
    if (!sessions.length) {
      list.createEl("p", {
        cls: "ghostwriter-sessions-empty",
        text: this.plugin.settings.backgroundMode
          ? "No sessions yet. Trigger a completion and switch notes freely — it keeps running here."
          : "No sessions yet. Enable Background mode to keep completions running when you switch notes.",
      });
      return;
    }
    for (const session of sessions) this.renderSession(list, session);
  }

  private renderSession(parent: HTMLElement, session: CompletionSession): void {
    const card = parent.createDiv({ cls: `ghostwriter-session is-${session.status}` });

    const head = card.createDiv({ cls: "ghostwriter-session-head" });
    head.createSpan({ cls: "ghostwriter-session-dot" });
    head.createSpan({ cls: "ghostwriter-session-name", text: session.title || "(untitled)" });
    head.createSpan({
      cls: "ghostwriter-session-meta",
      text: `${session.modeName} · ${sessionElapsed(session)} · ${STATUS_LABEL[session.status]}`,
    });

    card.createDiv({ cls: "ghostwriter-session-path", text: session.filePath || "—" });

    const actions = card.createDiv({ cls: "ghostwriter-session-actions" });

    const addButton = (label: string, icon: string, cls: string, onClick: () => void, disabled = false): void => {
      const btn = actions.createEl("button", { cls: `ghostwriter-session-btn ${cls}`, text: label });
      if (icon) setIcon(btn, icon);
      btn.disabled = disabled;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!btn.disabled) onClick();
      });
    };

    if (session.status === "running" || session.status === "preparing") {
      addButton("Cancel", "square", "mod-warning", () => this.plugin.cancelSession(session.id));
    }
    if (session.status === "done") {
      addButton("Accept", "check", "mod-cta", () => void this.plugin.acceptSession(session.id), !session.completion);
    }
    addButton("Open note", "file-text", "", () => void this.plugin.openSessionNote(session.id), !session.filePath);
    addButton("Remove", "trash", "", () => this.plugin.removeSession(session.id));
    if (session.status === "error" || session.status === "cancelled") {
      addButton("Retry", "rotate-cw", "", () => this.plugin.retrySession(session.id));
    }

    card.createDiv({
      cls: "ghostwriter-session-completion",
      text: session.completion || (session.status === "error" ? session.error ?? "(failed)" : "(waiting for text…)"),
    });

    if (session.thinking) {
      this.renderDetails(card, `${session.id}:thinking`, "Thinking", session.thinking);
    }

    this.renderDetails(card, `${session.id}:prompt`, "Prompt", () => {
      const prompt = this.plugin.sessionPrompt(session);
      if (!prompt) return "(prompt unavailable)";
      return prompt.map((m) => `--- ${m.role} ---\n${m.content}`).join("\n\n");
    });
  }

  private renderDetails(
    parent: HTMLElement,
    key: string,
    summary: string,
    body: string | (() => string)
  ): void {
    const details = parent.createEl("details", { cls: "ghostwriter-session-details" });
    if (this.openDetails.has(key)) details.open = true;
    details.createEl("summary", { text: summary });
    const pre = details.createEl("pre", { cls: "ghostwriter-session-pre" });
    let filled = false;
    const fill = (): void => {
      if (filled) return;
      filled = true;
      pre.setText(typeof body === "function" ? body() : body);
    };
    if (details.open) fill();
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openDetails.add(key);
        fill();
      } else {
        this.openDetails.delete(key);
      }
    });
  }
}
