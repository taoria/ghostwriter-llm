import { Plugin, Notice, Editor, TFile, TFolder, TAbstractFile, Modal, App, SuggestModal } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  GhostwriterSettings,
  ModeProfile,
  PromptLanguage,
  migrateSettings,
  captureActiveMode,
  applyModeToSettings,
  activeMode,
  cloneModeFromSettings,
  defaultModeProfiles,
} from "./settings";
import { GhostwriterSettingTab } from "./settingsTab";
import { CacheUsage, CompletionService, CompletionParams, formatCacheUsage, fetchModels } from "./completionService";
import { clearGhostEffect, getGhost, ghostExtension, setGhostEffect, GhostState } from "./ghostText";
import { ghostKeymap } from "./keymap";
import { parseInNoteSummaries } from "./util";
import { DEFAULT_NOVEL_SUMMARY_PROMPT_EN } from "./settings";
import { GhostPopup } from "./popup";
import { PreviewCard } from "./previewCard";
import { PromptPreviewModal, PromptSizeWarningModal } from "./promptPreviewModal";
import { GlobalHooksModal } from "./globalHooksModal";
import { CompletionSession, makeSessionId } from "./sessions";
import { SessionsView, VIEW_TYPE_SESSIONS } from "./sessionsView";
import { SummaryService, SummaryEntry } from "./summaryService";
import { SummaryOpRecord, SummaryStatusModal } from "./summaryStatusModal";

/** Warn before sending when the assembled prompt text exceeds 128k characters. */
const PROMPT_SIZE_WARNING_CHARS = 128 * 1024;

class InstructionModal extends Modal {
  private onSubmit: (instruction: string) => void;

  constructor(app: App, onSubmit: (instruction: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "Continue with an instruction" });
    this.contentEl.createEl("p", {
      text: "Write a short requirement for this continuation. It applies to this generation only.",
      cls: "setting-item-description",
    });

    const input = this.contentEl.createEl("input", { type: "text" });
    input.placeholder = "e.g. continue as a bullet list / keep a formal tone";
    input.style.width = "100%";
    setTimeout(() => input.focus(), 10);

    const submit = () => {
      const value = input.value.trim();
      this.close();
      if (value) this.onSubmit(value);
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    const btns = this.contentEl.createDiv();
    btns.style.display = "flex";
    btns.style.justifyContent = "flex-end";
    btns.style.gap = "8px";
    btns.style.marginTop = "12px";
    const cancel = btns.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const ok = btns.createEl("button", { text: "Continue", cls: "mod-cta" });
    ok.addEventListener("click", () => submit());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ModeSwitchModal extends SuggestModal<ModeProfile> {
  constructor(app: App, private plugin: GhostwriterPlugin) {
    super(app);
    this.setPlaceholder("Switch writing mode…");
  }

  getSuggestions(query: string): ModeProfile[] {
    const q = query.trim().toLowerCase();
    return this.plugin.settings.modes.filter((m) => !q || m.name.toLowerCase().includes(q));
  }

  renderSuggestion(mode: ModeProfile, el: HTMLElement): void {
    el.setText(mode.name);
    if (mode.id === this.plugin.settings.activeModeId) el.addClass("is-active");
  }

  onChooseSuggestion(mode: ModeProfile): void {
    void this.plugin.switchMode(mode.id);
  }
}

export default class GhostwriterPlugin extends Plugin {
  settings!: GhostwriterSettings;
  private service!: CompletionService;
  summaryService!: SummaryService;
  private popup!: GhostPopup;
  private preview: PreviewCard | null = null;
  private summaryAbort: AbortController | null = null;
  /** All completion sessions, newest first (running or finished). */
  private sessions: CompletionSession[] = [];
  /** Most recently started/active session. */
  private activeSessionId: string | null = null;
  private sessionsRefreshTimer: number | null = null;
  /** Last Markdown editor/view that was active, used by the sidebar instruction bar. */
  private lastEditor: Editor | null = null;
  private lastView: EditorView | null = null;
  private sessionSummaryOn: boolean = true;
  private statusBarEl: HTMLElement | null = null;
  private currentSummaryStatusBarEl: HTMLElement | null = null;
  private cacheStatusBarEl: HTMLElement | null = null;
  private summaryOpStatusBarEl: HTMLElement | null = null;
  private lastCacheUsage: CacheUsage | undefined;
  private cacheUsageKnown: boolean = false;
  /** In-session history of summary generation operations (newest first). */
  summaryOps: SummaryOpRecord[] = [];

  async onload() {
    await this.loadSettings();

    this.service = new CompletionService(() => this.settings);
    this.summaryService = new SummaryService(this.app, () => this.settings);
    this.popup = new GhostPopup({
      onRegenerate: () => this.regenerate(),
      onDismiss: () => this.dismiss(),
    });

    this.registerView(VIEW_TYPE_SESSIONS, (leaf) => new SessionsView(leaf, this));

    this.registerEditorExtension([ghostExtension, ghostKeymap({
      onAccept: (view) => this.accept(view),
      onDismiss: (view) => this.dismiss(view),
      isBusy: (view) => this.hasRunningSessionForView(view),
    }, () => ({
      accept: this.settings.acceptKey,
      dismiss: this.settings.dismissKey,
    }))]);

    this.addRibbonIcon("sparkles", "Ghostwriter sessions", () => {
      void this.activateSessionsView();
    });

    this.addCommand({
      id: "open-background-sessions",
      name: "Open background sessions",
      callback: () => {
        void this.activateSessionsView();
      },
    });

    this.addCommand({
      id: "trigger-llm-completion",
      name: "Trigger LLM completion at cursor",
      editorCallback: (editor: Editor) => {
        const view = this.getViewFromEditor(editor);
        if (!view) return;
        this.triggerCompletion(editor, view);
      },
    });

    this.addCommand({
      id: "trigger-llm-completion-with-instruction",
      name: "Trigger LLM completion with an instruction",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      editorCallback: (editor: Editor) => {
        const view = this.getViewFromEditor(editor);
        if (!view) return;
        new InstructionModal(this.app, (instruction) => {
          if (!instruction) return;
          void this.triggerCompletion(editor, view, instruction);
        }).open();
      },
    });

    this.addCommand({
      id: "switch-writing-mode",
      name: "Switch writing mode",
      callback: () => {
        new ModeSwitchModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "manage-global-hooks",
      name: "Manage global context hooks",
      callback: () => {
        this.openGlobalHooks();
      },
    });

    this.addCommand({
      id: "dismiss-llm-completion",
      name: "Dismiss current LLM suggestion",
      editorCallback: () => {
        this.dismiss();
      },
    });

    this.addCommand({
      id: "generate-in-note-summary",
      name: "Generate In-Note Summary",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "S" }],
      editorCallback: (editor: Editor) => {
        void this.generateInNoteSummary(editor);
      },
    });

    this.addCommand({
      id: "show-summary-status",
      name: "Show summary status",
      callback: () => {
        this.openSummaryStatus();
      },
    });

    this.addCommand({
      id: "toggle-summary-injection",
      name: "Toggle summary injection (session)",
      callback: () => {
        this.sessionSummaryOn = !this.sessionSummaryOn;
        this.updateStatusBar();
        new Notice(`Summary injection ${this.sessionSummaryOn ? "ON" : "OFF"}`);
      },
    });

    this.addCommand({
      id: "toggle-current-summary-injection",
      name: "Toggle current note summary injection",
      editorCallback: () => {
        void this.toggleCurrentSummary();
      },
    });

    this.addCommand({
      id: "regenerate-current-note-summary",
      name: "Generate summary for current note",
      editorCallback: async (editor: Editor) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !(f instanceof TFile) || !f.path.toLowerCase().endsWith(".md")) {
          new Notice("No active Markdown note");
          return;
        }
        new Notice("Generating summary…");
        const ac = new AbortController();
        this.summaryAbort = ac;
        const rec = this.beginSummaryOp("note-summary", f.path);
        try {
          const summary = await this.summaryService.regenerate(f, ac.signal);
          if (summary) {
             this.finishSummaryOp(rec, "success", "saved to summaries folder");
             new Notice("Summary saved.");
          } else {
            this.finishSummaryOp(rec, "failed", "cancelled");
            new Notice("Summary cancelled.");
          }
        } catch (err) {
          if (ac.signal.aborted) {
            this.finishSummaryOp(rec, "failed", "cancelled");
            return;
          }
          console.error("[ghostwriter] summary generation failed", err);
          this.finishSummaryOp(rec, "failed", (err as Error).message);
          new Notice(`Summary generation failed: ${(err as Error).message}`, 10000);
        } finally {
          this.summaryAbort = null;
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const v = this.activeEditorView();
        if (v) {
          this.lastView = v;
          const ed = this.app.workspace.activeEditor?.editor;
          if (ed) this.lastEditor = ed;
        }
        this.updateStatusBar();
        if (this.settings.backgroundMode) {
          // Sessions keep running in the background; hide the floating popup of the previous view.
          this.popup.hide();
          // Returning to a note whose completion finished while away: re-show its action bar.
          const v = this.activeEditorView();
          if (v && getGhost(v.state)) {
            const done = this.sessions.find((s) => s.view === v && s.status === "done");
            if (done) this.popup.showActions(v, done.anchorOffset);
          }
        } else {
          // Legacy behavior: switching notes cancels the current suggestion.
          this.dismiss();
        }
        this.scheduleSessionsRefresh();
      })
    );

    // Keep summaries and disable lists in sync when notes/folders are renamed or moved.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.handleVaultRename(file, oldPath);
      })
    );

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("ghostwriter-status");
    this.statusBarEl.setAttribute("aria-label", "Toggle LLM summary injection");
    this.statusBarEl.addEventListener("click", () => {
      this.sessionSummaryOn = !this.sessionSummaryOn;
      this.updateStatusBar();
      new Notice(`Summary injection ${this.sessionSummaryOn ? "ON" : "OFF"}`);
    });

    this.currentSummaryStatusBarEl = this.addStatusBarItem();
    this.currentSummaryStatusBarEl.addClass("ghostwriter-status", "ghostwriter-current-summary-status");
    this.currentSummaryStatusBarEl.setAttribute("aria-label", "Toggle current note summary injection");
    this.currentSummaryStatusBarEl.addEventListener("click", () => {
      void this.toggleCurrentSummary();
    });

    this.cacheStatusBarEl = this.addStatusBarItem();
    this.cacheStatusBarEl.addClass("ghostwriter-status", "ghostwriter-cache-status");
    this.cacheStatusBarEl.setAttribute("aria-label", "Prompt cache hit rate from the last completion");
    this.updateStatusBar();

    this.summaryOpStatusBarEl = this.addStatusBarItem();
    this.summaryOpStatusBarEl.addClass("ghostwriter-status", "ghostwriter-summaryop-status");
    this.summaryOpStatusBarEl.setAttribute("aria-label", "Summary generation status (click to open)");
    this.summaryOpStatusBarEl.addEventListener("click", () => {
      new SummaryStatusModal(this.app, this).open();
    });

    this.addSettingTab(new GhostwriterSettingTab(this.app, this));
  }

  beginSummaryOp(kind: SummaryOpRecord["kind"], target: string): SummaryOpRecord {
    const rec: SummaryOpRecord = { time: Date.now(), kind, target, state: "running", message: "" };
    this.summaryOps.unshift(rec);
    if (this.summaryOps.length > 30) this.summaryOps.length = 30;
    this.updateSummaryOpStatus();
    return rec;
  }

  finishSummaryOp(rec: SummaryOpRecord, state: SummaryOpRecord["state"], message: string): void {
    rec.state = state;
    rec.message = message;
    rec.time = state === "running" ? rec.time : Date.now();
    this.updateSummaryOpStatus();
  }

  updateSummaryOpStatus(): void {
    if (!this.summaryOpStatusBarEl) return;
    const running = this.summaryOps.find((o) => o.state === "running");
    const last = this.summaryOps[0];
    if (running) {
      this.summaryOpStatusBarEl.setText("Summary: …");
      this.summaryOpStatusBarEl.toggleClass("is-running", true);
      this.summaryOpStatusBarEl.toggleClass("is-on", false);
      this.summaryOpStatusBarEl.toggleClass("is-off", false);
    } else if (last && last.state === "failed") {
      this.summaryOpStatusBarEl.setText("Summary: FAIL");
      this.summaryOpStatusBarEl.toggleClass("is-running", false);
      this.summaryOpStatusBarEl.toggleClass("is-on", false);
      this.summaryOpStatusBarEl.toggleClass("is-off", false);
      this.summaryOpStatusBarEl.toggleClass("is-failed", true);
    } else if (last && last.state === "success") {
      this.summaryOpStatusBarEl.setText("Summary: OK");
      this.summaryOpStatusBarEl.toggleClass("is-running", false);
      this.summaryOpStatusBarEl.toggleClass("is-on", true);
      this.summaryOpStatusBarEl.toggleClass("is-off", false);
      this.summaryOpStatusBarEl.toggleClass("is-failed", false);
    } else {
      this.summaryOpStatusBarEl.setText("Summary: idle");
      this.summaryOpStatusBarEl.toggleClass("is-running", false);
      this.summaryOpStatusBarEl.toggleClass("is-on", false);
      this.summaryOpStatusBarEl.toggleClass("is-off", false);
      this.summaryOpStatusBarEl.toggleClass("is-failed", false);
    }
  }

  openSummaryStatus(): void {
    new SummaryStatusModal(this.app, this).open();
  }

  openGlobalHooks(): void {
    new GlobalHooksModal(this.app, this).open();
  }

  /**
   * Sidebar instruction bar: trigger a completion at the last active note's
   * cursor with a one-shot instruction (same mechanism as the instruction command).
   */
  triggerInstruction(instruction: string, maxWords?: number): boolean {
    const text = instruction.trim();
    if (!text) return false;
    const view = this.activeEditorView() ?? this.lastView;
    const editor = this.app.workspace.activeEditor?.editor ?? this.lastEditor;
    if (!view || !editor) {
      new Notice("Open a note first, then send an instruction");
      return false;
    }
    this.lastView = view;
    this.lastEditor = editor;
    void this.triggerCompletion(editor, view, text, maxWords);
    return true;
  }

  onunload() {
    this.popup?.destroy();
    this.preview?.close();
    this.summaryAbort?.abort();
    for (const session of this.sessions) session.abort.abort();
    if (this.sessionsRefreshTimer !== null) window.clearTimeout(this.sessionsRefreshTimer);
  }

  async loadSettings() {
    this.settings = migrateSettings(await this.loadData());
    await this.saveSettings();
  }

  async switchProvider(id: string): Promise<void> {
    const p = this.settings.providers.find((x) => x.id === id);
    if (!p) return;
    this.settings.activeProviderId = p.id;
    await this.saveSettings();
  }

  async saveSettings() {
    captureActiveMode(this.settings);
    await this.saveData(this.settings);
  }

  /** Switch the active writing mode: persist the current one, then load the target. */
  async switchMode(id: string): Promise<void> {
    const s = this.settings;
    const target = s.modes.find((m) => m.id === id);
    if (!target || target.id === s.activeModeId) return;
    captureActiveMode(s);
    s.activeModeId = target.id;
    applyModeToSettings(s, target);
    await this.saveSettings();
    this.updateStatusBar();
    new Notice(`Writing mode: ${target.name}`);
  }

  /** Create a new mode cloned from the current live values and activate it. */
  async addMode(name: string): Promise<void> {
    const s = this.settings;
    captureActiveMode(s);
    const mode = cloneModeFromSettings(s, name.trim() || `Mode ${s.modes.length + 1}`);
    s.modes.push(mode);
    s.activeModeId = mode.id;
    applyModeToSettings(s, mode);
    await this.saveSettings();
    new Notice(`Mode "${mode.name}" added`);
  }

  async deleteMode(id: string): Promise<void> {
    const s = this.settings;
    if (s.modes.length <= 1) return;
    const idx = s.modes.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const removed = s.modes.splice(idx, 1)[0];
    if (s.activeModeId === id) {
      s.activeModeId = s.modes[0].id;
      applyModeToSettings(s, s.modes[0]);
    }
    await this.saveSettings();
    new Notice(`Mode "${removed.name}" deleted`);
  }

  /** Reset the active mode's prompt/context/recall/summary fields to built-in defaults. */
  async restoreModeDefaults(lang: PromptLanguage): Promise<void> {
    const s = this.settings;
    const m = activeMode(s);
    if (!m) return;
    const builtin = defaultModeProfiles(lang).find((d) => d.id === m.id) ?? defaultModeProfiles(lang)[0];
    for (const k of Object.keys(builtin) as (keyof ModeProfile)[]) {
      if (k === "id" || k === "name") continue;
      (m as unknown as Record<string, unknown>)[k] = builtin[k];
    }
    applyModeToSettings(s, m);
    await this.saveSettings();
    new Notice(`Mode "${m.name}" restored to ${lang === "zh" ? "中文" : "English"} defaults`);
  }

  private getViewFromEditor(editor: Editor): EditorView | null {
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    return cm ?? null;
  }

  private findSession(id: string): CompletionSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  getSessions(): CompletionSession[] {
    return this.sessions;
  }

  private runningSessionForView(view: EditorView): CompletionSession | undefined {
    return this.sessions.find(
      (s) => s.view === view && (s.status === "running" || s.status === "preparing")
    );
  }

  hasRunningSessionForView(view: EditorView): boolean {
    return !!this.runningSessionForView(view);
  }

  private newestRunningSession(): CompletionSession | undefined {
    return this.sessions.find((s) => s.status === "running" || s.status === "preparing");
  }

  cancelSession(id: string): void {
    const s = this.findSession(id);
    if (!s) return;
    if (s.status === "running" || s.status === "preparing") {
      s.abort.abort();
      s.status = "cancelled";
      s.updatedAt = Date.now();
      if (s.view) this.clearGhostInView(s.view);
      if (this.activeSessionId === id) this.popup.hide();
    }
    this.scheduleSessionsRefresh();
  }

  removeSession(id: string): void {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const s = this.sessions[idx];
    s.abort.abort();
    if (s.view) this.clearGhostInView(s.view);
    this.sessions.splice(idx, 1);
    if (this.activeSessionId === id) this.activeSessionId = this.sessions[0]?.id ?? null;
    this.scheduleSessionsRefresh();
  }

  clearFinishedSessions(): void {
    for (const session of [...this.sessions]) {
      if (session.status !== "running" && session.status !== "preparing") {
        this.removeSession(session.id);
      }
    }
  }

  private scheduleSessionsRefresh(): void {
    if (this.sessionsRefreshTimer !== null) return;
    this.sessionsRefreshTimer = window.setTimeout(() => {
      this.sessionsRefreshTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSIONS)) {
        if (leaf.view instanceof SessionsView) leaf.view.render();
      }
    }, 150);
  }

  async activateSessionsView(reveal = true): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSIONS);
    if (existing.length) {
      const leaf = existing[0];
      if (reveal) this.app.workspace.revealLeaf(leaf);
      if (leaf.view instanceof SessionsView) leaf.view.render();
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_SESSIONS, active: reveal });
    if (reveal) this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof SessionsView) leaf.view.render();
  }

  private clearGhostInView(view: EditorView) {
    try {
      view.dispatch({ effects: clearGhostEffect.of(null) });
    } catch {
      // The view was destroyed; nothing to clear.
    }
  }

  private setGhostInView(view: EditorView, state: GhostState) {
    try {
      view.dispatch({ effects: setGhostEffect.of(state) });
    } catch {
      // The view was destroyed; the session keeps running for the sidebar.
    }
  }

  private isViewActive(view: EditorView): boolean {
    const ae = this.app.workspace.activeEditor;
    const cm = (ae?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    return cm === view;
  }

  private editorForView(view: EditorView): Editor | null {
    const session = this.sessions.find((x) => x.view === view);
    if (session?.editor) return session.editor;
    const ae = this.app.workspace.activeEditor;
    const cm = (ae?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    return cm === view ? ae?.editor ?? null : null;
  }

  private getActiveNoteTitle(): string {
    const file = this.app.workspace.getActiveFile();
    if (!file) return "";
    const name = file.basename ?? file.name ?? "";
    return name.replace(/\.md$/i, "");
  }

  private async triggerCompletion(editor: Editor, view: EditorView, instruction: string = "", maxWords?: number) {
    this.lastEditor = editor;
    this.lastView = view;
    // Only one live completion per editor: cancel whatever is still running there.
    const existing = this.runningSessionForView(view);
    if (existing) {
      this.cancelSession(existing.id);
    }
    this.clearGhostInView(view);
    this.preview?.close();
    this.preview = null;

    const cursorPos = view.state.selection.main.head;
    const file = this.app.workspace.getActiveFile();
    const ac = new AbortController();
    const session: CompletionSession = {
      id: makeSessionId(),
      filePath: file instanceof TFile ? file.path : "",
      title: this.getActiveNoteTitle(),
      modeName: activeMode(this.settings)?.name ?? "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "preparing",
      params: { prefix: "", suffix: "", summary: "", title: this.getActiveNoteTitle() },
      completion: "",
      thinking: "",
      abort: ac,
      view,
      editor,
      anchorOffset: cursorPos,
      doc: view.state.doc,
      inline: !this.settings.previewMode,
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    // A new completion on this note replaces any older preview there; with more
    // than one live session for the note, inline ghosts are suppressed (sidebar only).
    for (const s of this.sessions) {
      if (s.id !== session.id && s.filePath === session.filePath && s.view) {
        this.clearGhostInView(s.view);
      }
    }
    this.scheduleSessionsRefresh();
    this.resetCacheStatus();
    this.popup.showLoading(view, cursorPos);

    const summaryOn = this.sessionSummaryOn && this.settings.summaryEnabled;
    let summary = "";
    if (summaryOn) {
      try {
        summary = await this.buildSummaryContext(ac.signal);
      } catch (err) {
        console.warn("summary build failed", err);
      }
    }
    let hooks = "";
    try {
      hooks = await this.buildHookContext(ac.signal);
    } catch (err) {
      console.warn("global hooks build failed", err);
    }
    if (ac.signal.aborted) {
      this.popup.hide();
      return;
    }

    const ctx = this.buildContext(editor);
    const params: CompletionParams = {
      prefix: ctx.prefix,
      suffix: ctx.suffix,
      summary,
      hooks,
      title: session.title,
      instruction,
      maxWords,
    };
    session.params = params;
    session.anchorOffset = view.state.selection.main.head;
    session.doc = view.state.doc;
    session.status = "running";
    session.updatedAt = Date.now();
    this.scheduleSessionsRefresh();

    this.startCompletionRun(session, view, session.anchorOffset, ac);
  }

  /** Optionally show the assembled prompt for confirmation before the request is sent. */
  private startCompletionRun(session: CompletionSession, view: EditorView, pos: number, ac: AbortController): void {
    let payload: ReturnType<CompletionService["buildPayload"]>;
    try {
      payload = this.service.buildPayload(session.params, this.settings.stream);
    } catch (err) {
      this.popup.hide();
      this.cancelSession(session.id);
      new Notice(`Cannot build prompt: ${(err as Error).message}`, 10000);
      return;
    }

    const chars = payload.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    const proceed = (): void => {
      if (this.settings.promptPreviewBeforeSend) {
        this.popup.hide();
        new PromptPreviewModal(this.app, payload, {
          onSend: () => this.launchCompletion(session, view, pos, ac),
          onCancel: () => {
            this.popup.hide();
            this.cancelSession(session.id);
          },
        }).open();
        return;
      }
      this.launchCompletion(session, view, pos, ac);
    };

    if (this.settings.warnOversizePrompt && chars > PROMPT_SIZE_WARNING_CHARS) {
      this.popup.hide();
      new PromptSizeWarningModal(this.app, chars, PROMPT_SIZE_WARNING_CHARS, {
        onContinue: proceed,
        onCancel: () => {
          this.popup.hide();
          this.cancelSession(session.id);
        },
        onDisableWarning: async () => {
          this.settings.warnOversizePrompt = false;
          await this.saveSettings();
        },
      }).open();
      return;
    }

    proceed();
  }

  private launchCompletion(session: CompletionSession, view: EditorView, pos: number, ac: AbortController): void {
    if (this.settings.previewMode && !this.settings.backgroundMode) {
      // Non-background preview: review in the modal card, no inline ghost.
      session.inline = false;
      this.popup.hide();
      this.runPreviewCompletion(session, view, pos, ac);
      return;
    }
    // Inline everywhere else — including background mode, so the target note shows
    // the ghost when only one session is running for that note.
    session.inline = true;
    if (this.settings.backgroundMode && this.settings.previewMode) {
      void this.activateSessionsView(false);
    }
    this.popup.showLoading(view, pos);
    this.runInlineCompletion(session, view, pos, ac);
  }

  /**
   * Assemble the global-hook blocks: notes pinned into every prompt, rendered
   * with the active (or per-item override) context strategy.
   */
  private async buildHookContext(signal: AbortSignal): Promise<string> {
    const s = this.settings;
    if (!s.globalHooksEnabled || !s.globalHooks.length) return "";
    const active = this.app.workspace.getActiveFile();
    const blocks: string[] = [];
    for (const hook of s.globalHooks) {
      if (signal.aborted) return "";
      if (!hook.enabled) continue;
      if (active && hook.path === active.path) continue;
      const file = this.app.vault.getAbstractFileByPath(hook.path);
      if (!(file instanceof TFile) || !file.path.toLowerCase().endsWith(".md")) continue;
      let raw = "";
      try {
        raw = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const mode = hook.contextMode === "follow" ? (s.contextMode ?? "full") : hook.contextMode;
      let content = raw;
      if (mode === "in-note") {
        const parsed = parseInNoteSummaries(raw);
        if (parsed.hasAny) {
          const summaries = parsed.summaries.map((x) => `[Summary] ${x}`).join("\n");
          const tail = parsed.tail.trim();
          content = tail ? `${summaries}\n\n${tail}` : summaries;
        }
      }
      content = content.trim();
      if (hook.maxChars > 0 && content.length > hook.maxChars) content = content.slice(0, hook.maxChars);
      if (!content) continue;
      blocks.push(`[Global context: ${file.basename}]\n${content}`);
    }
    return blocks.join("\n\n");
  }

  private async buildSummaryContext(signal: AbortSignal): Promise<string> {
    const s = this.settings;
    const level = this.recallLevel();
    if (level === 0) return "";
    const file = this.app.workspace.getActiveFile();
    const parts: string[] = [];
    const hookPaths = this.activeHookPaths();

    if (level < 3) {
      if (file instanceof TFile && file.path.toLowerCase().endsWith(".md")) {
        try {
          const activeSummary = await this.summaryService.findForFile(file);
          if (signal.aborted) return "";
          if (
            activeSummary &&
            activeSummary.summaryFilePath !== file.path &&
            !this.summaryKeyDisabled(activeSummary.path) &&
            !this.summaryKeyDisabled(activeSummary.summaryFilePath)
          ) {
            parts.push(`[Summary: ${activeSummary.title}]\n${activeSummary.summary}`);
          }
        } catch (err) {
          console.warn("findCurrentNoteSummary failed", err);
        }
      }

      let others: SummaryEntry[] = [];
      try {
        others = await this.summaryService.collectAll(s.summaryScanLimit);
      } catch (err) {
        console.warn("collectAll failed", err);
      }
      others = others.filter(
        (e) =>
          !hookPaths.has(e.path) &&
          (!(file instanceof TFile) ||
            (e.path !== file.path && e.summaryFilePath !== file.path))
      );
      others.sort((a, b) => a.title.localeCompare(b.title));
      for (const e of others) {
        if (signal.aborted) return "";
        if (!this.summaryKeyDisabled(e.path) && !this.summaryKeyDisabled(e.summaryFilePath)) {
          parts.push(`[Summary: ${e.title}]\n${e.summary}`);
        }
      }

      const manual = (s.summary ?? "").trim();
      if (manual) {
        parts.push(`[Manual summary]\n${manual}`);
      }
    }

    if (level >= 2 && file instanceof TFile) {
      const depth = level >= 3 ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(s.adjacentDepth || 1));
      const maxNotes = Math.max(1, Math.floor(s.adjacentMaxNotes || 20));
      try {
        const blocks = await this.adjacentNoteBlocks(file, depth, maxNotes, signal, hookPaths);
        parts.push(...blocks);
      } catch (err) {
        console.warn("adjacent notes recall failed", err);
      }
    }
    if (signal.aborted) return "";

    return parts.join("\n\n");
  }

  private recallLevel(): number {
    const lvl = Math.floor(Number(this.settings.recallLevel ?? 1));
    return Math.min(3, Math.max(0, Number.isFinite(lvl) ? lvl : 1));
  }

  /** Paths of enabled hooks; used to avoid injecting the same note twice via adjacent notes/summaries. */
  private activeHookPaths(): Set<string> {
    const s = this.settings;
    return new Set(
      s.globalHooksEnabled ? s.globalHooks.filter((h) => h.enabled).map((h) => h.path) : []
    );
  }

  /**
   * Build the cursor context according to the active mode's context strategy:
   * - "in-note": in-note summary blocks (`[Summary]` / `[摘要]` markers anywhere
   *   in a line) are detected; the summarized text is not sent raw — the summaries
   *   are injected immediately before the unsummarized tail (inside {prefix}).
   *   With no markers it falls back to the full preceding text.
   * - "full": the whole text before the cursor.
   *
   * Neither prefix nor suffix is truncated; oversized prompts are warned about
   * before sending instead.
   */
  private buildContext(editor: Editor): { prefix: string; suffix: string } {
    const cursor = editor.getCursor("head");
    const lastLineNum = editor.lastLine();
    const docEnd = { line: lastLineNum, ch: editor.getLine(lastLineNum).length };
    const suffix = editor.getRange(cursor, docEnd);

    const fullPrefix = editor.getRange({ line: 0, ch: 0 }, cursor);
    const mode = this.settings.contextMode ?? "full";

    if (mode === "in-note") {
      const parsed = parseInNoteSummaries(fullPrefix);
      if (parsed.hasAny) {
        const tail = parsed.tail.replace(/^[\s\r\n]+/, "").replace(/[\s\r\n]+$/, "");
        const block = parsed.summaries.map((s, idx) => `[Summary ${idx + 1}] ${s}`).join("\n");
        const prefix = tail ? `${block}\n\n${tail}` : block;
        return { prefix, suffix };
      }
    }

    return { prefix: fullPrefix, suffix };
  }

  /** A summary is skipped when either its source-note path or its summary-file path is in the disable list. */
  private summaryKeyDisabled(key: string): boolean {
    return (this.settings.disabledSummaryFiles ?? []).includes(key);
  }

  /**
   * Collect content blocks of "adjacent" notes — notes linked to/from the current
   * note (symmetric at depth 1; deeper hops follow outgoing links only).
   * Summary files themselves are never injected as adjacent notes.
   */
  private async adjacentNoteBlocks(
    current: TFile,
    depth: number,
    maxNotes: number,
    signal: AbortSignal,
    exclude?: Set<string>
  ): Promise<string[]> {
    const resolved = (this.app.metadataCache.resolvedLinks ?? {}) as Record<string, Record<string, number>>;
    const outgoing = (p: string): string[] => Object.keys(resolved[p] ?? {});

    const frontier = new Set<string>();
    for (const t of outgoing(current.path)) {
      if (t !== current.path) frontier.add(t);
    }
    for (const [src, row] of Object.entries(resolved)) {
      if (row && row[current.path] !== undefined && src !== current.path) frontier.add(src);
    }

    const expanded = new Set<string>([current.path]);
    for (let d = 1; d < depth; d++) {
      const grow: string[] = [];
      for (const p of frontier) {
        if (expanded.has(p)) continue;
        expanded.add(p);
        for (const t of outgoing(p)) {
          if (!frontier.has(t) && !expanded.has(t)) grow.push(t);
        }
      }
      if (!grow.length) break;
      for (const t of grow) frontier.add(t);
    }

    const folder = (this.settings.summaryFolder ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const noteCap = Math.max(200, Math.floor(this.settings.adjacentNoteChars || 1500));
    let remaining = Math.max(noteCap, Math.floor(this.settings.adjacentTotalChars || 12000));
    const sorted = [...frontier].sort((a, b) => a.localeCompare(b));
    const blocks: string[] = [];
    for (const path of sorted) {
      if (blocks.length >= maxNotes || signal.aborted || remaining <= 0) break;
      if (path === current.path || !path.toLowerCase().endsWith(".md")) continue;
      if (exclude?.has(path)) continue;
      if (folder && path.startsWith(`${folder}/`)) continue;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      try {
        const content = await this.app.vault.cachedRead(f);
        const clipped = content.slice(0, Math.min(noteCap, remaining)).trim();
        if (clipped) {
          blocks.push(`[Note: ${f.basename}]\n${clipped}`);
          remaining -= clipped.length;
        }
      } catch {
        // Skip unreadable files.
      }
    }
    return blocks;
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const s = this.settings;
    let touched = false;

    const remapLists = (exactOld: string, newP: string, prefixMode: boolean) => {
      const remap = (p: string): string =>
        prefixMode
          ? p.startsWith(exactOld + "/")
            ? newP + p.slice(exactOld.length)
            : p
          : p === exactOld
            ? newP
            : p;
      const apply = (list: string[] | undefined): [string[], boolean] => {
        const arr = list ?? [];
        const next = arr.map(remap);
        const changed = next.some((p, i) => p !== arr[i]);
        return [next, changed] as [string[], boolean];
      };
      const [fp, fChanged] = apply(s.disabledSummaryFiles);
      if (fChanged) {
        s.disabledSummaryFiles = fp;
        touched = true;
      }
    };

    try {
      if (file instanceof TFile && file.path.toLowerCase().endsWith(".md")) {
        remapLists(oldPath, file.path, false);
        await this.summaryService.renameSources((src) => (src === oldPath ? file.path : null));
      } else if (file instanceof TFolder) {
        remapLists(oldPath, file.path, true);
        await this.summaryService.renameSources((src) =>
          src.startsWith(oldPath + "/") ? file.path + src.slice(oldPath.length) : null
        );
      }
    } catch (err) {
      console.warn("rename sync failed", err);
    }
    if (touched) {
      await this.saveSettings();
      this.updateStatusBar();
    }
  }

  private isSummaryEnabled(sourcePath: string): boolean {
    return !this.summaryKeyDisabled(sourcePath);
  }

  private async toggleCurrentSummary(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !file.path.toLowerCase().endsWith(".md")) {
      new Notice("No active Markdown note");
      return;
    }

    let summaryFilePath: string | null = null;
    try {
      summaryFilePath = (await this.summaryService.findForFile(file))?.summaryFilePath ?? null;
    } catch {
      // No summary file yet; the source-path key still controls future summaries.
    }
    const keys = [file.path];
    if (summaryFilePath && summaryFilePath !== file.path) keys.push(summaryFilePath);
    const list = this.settings.disabledSummaryFiles ?? [];
    const disabled = keys.some((k) => list.includes(k));
    this.settings.disabledSummaryFiles = disabled
      ? list.filter((p) => !keys.includes(p))
      : [...list, ...keys.filter((k) => !list.includes(k))];
    await this.saveSettings();
    this.updateStatusBar();
    new Notice(`Current note summary ${disabled ? "ON" : "OFF"}`);
  }

  updateStatusBar(): void {
    const summaryActive = this.sessionSummaryOn && this.settings.summaryEnabled;
    if (this.statusBarEl) {
      this.statusBarEl.setText(summaryActive ? "Summary: ON" : "Summary: OFF");
      this.statusBarEl.toggleClass("is-on", summaryActive);
      this.statusBarEl.toggleClass("is-off", !summaryActive);
    }

    if (this.currentSummaryStatusBarEl) {
      const file = this.app.workspace.getActiveFile();
      const noteActive = !!file && file.path.toLowerCase().endsWith(".md");
      const currentSummaryOn = noteActive && this.isSummaryEnabled(file.path);
      this.currentSummaryStatusBarEl.setText(noteActive ? `Note summary: ${currentSummaryOn ? "ON" : "OFF"}` : "Note summary: N/A");
      this.currentSummaryStatusBarEl.toggleClass("is-on", currentSummaryOn);
      this.currentSummaryStatusBarEl.toggleClass("is-off", noteActive && !currentSummaryOn);
      this.currentSummaryStatusBarEl.toggleClass("is-na", !noteActive);
    }

    this.updateCacheStatus();
  }

  private resetCacheStatus(): void {
    this.lastCacheUsage = undefined;
    this.cacheUsageKnown = false;
    this.updateCacheStatus();
  }

  private recordCacheUsage(usage?: CacheUsage): void {
    this.lastCacheUsage = usage;
    this.cacheUsageKnown = true;
    this.updateCacheStatus();
  }

  private updateCacheStatus(): void {
    if (!this.cacheStatusBarEl) return;
    if (!this.cacheUsageKnown) {
      this.cacheStatusBarEl.setText("Cache: --");
      this.cacheStatusBarEl.setAttribute("title", "No completion has been completed yet");
      this.cacheStatusBarEl.toggleClass("is-available", false);
      this.cacheStatusBarEl.toggleClass("is-na", true);
      return;
    }
    if (!this.lastCacheUsage) {
      this.cacheStatusBarEl.setText("Cache: N/A");
      this.cacheStatusBarEl.setAttribute("title", "The provider did not report prompt cache usage");
      this.cacheStatusBarEl.toggleClass("is-available", false);
      this.cacheStatusBarEl.toggleClass("is-na", true);
      return;
    }
    this.cacheStatusBarEl.setText(`Cache: ${formatCacheUsage(this.lastCacheUsage).split(" (")[0]}`);
    this.cacheStatusBarEl.setAttribute("title", `Prompt cache: ${formatCacheUsage(this.lastCacheUsage)}`);
    this.cacheStatusBarEl.toggleClass("is-available", true);
    this.cacheStatusBarEl.toggleClass("is-na", false);
  }

  private sessionContextIsCurrent(
    session: CompletionSession,
    view: EditorView,
    doc: typeof view.state.doc
  ): boolean {
    if (session.abort.signal.aborted || session.view !== view) return false;
    // Moving the cursor / switching notes must NOT cancel generation. Only an edit
    // to the target note invalidates the request (the anchor position would shift).
    if (view.state.doc === doc) return true;
    this.cancelSession(session.id);
    this.popup.hide();
    return false;
  }

  /** True when this session is the only live one for its note (multi-session notes skip the ghost). */
  private ghostAllowedForNote(session: CompletionSession): boolean {
    if (!session.filePath) return true;
    return !this.sessions.some(
      (s) =>
        s.id !== session.id &&
        s.filePath === session.filePath &&
        (s.status === "running" || s.status === "preparing")
    );
  }

  private runInlineCompletion(session: CompletionSession, view: EditorView, pos: number, ac: AbortController) {
    const peek = this.settings.peekCoT;
    const sourceDoc = view.state.doc;
    const renderGhost = (): boolean =>
      session.inline && this.ghostAllowedForNote(session);

    let accumulated = "";

    this.service.complete(
      session.params,
      {
        onThinkingDelta: (delta) => {
          if (ac.signal.aborted) return;
          session.thinking += delta;
          session.updatedAt = Date.now();
          this.scheduleSessionsRefresh();
          if (peek && session.inline && this.isViewActive(view)) this.popup.appendThinking(delta);
        },
        onCompletionDelta: (delta) => {
          if (!this.sessionContextIsCurrent(session, view, sourceDoc)) return;
          accumulated += delta;
          session.completion = accumulated;
          session.updatedAt = Date.now();
          this.scheduleSessionsRefresh();
          if (renderGhost()) this.setGhostInView(view, { text: accumulated, pos });
        },
        onRestart: () => {
          if (ac.signal.aborted) return;
          accumulated = "";
          session.completion = "";
          if (renderGhost()) this.clearGhostInView(view);
        },
        onDone: (completion, thinking, cacheUsage) => {
          if (!this.sessionContextIsCurrent(session, view, sourceDoc)) return;
          session.completion = completion || accumulated;
          session.thinking = thinking || session.thinking;
          session.cacheUsage = cacheUsage;
          session.status = "done";
          session.updatedAt = Date.now();
          this.recordCacheUsage(cacheUsage);
          this.scheduleSessionsRefresh();
          if (session.completion) {
            if (renderGhost()) this.setGhostInView(view, { text: session.completion, pos });
            if (session.inline && this.isViewActive(view)) this.popup.showActions(view, pos);
          } else {
            if (renderGhost()) this.clearGhostInView(view);
            if (session.inline && this.isViewActive(view)) this.popup.hide();
          }
          if (!this.isViewActive(view)) {
            new Notice(`Completion ready: ${session.title} (Ghostwriter sessions sidebar)`, 5000);
          }
        },
        onError: (err) => {
          if (ac.signal.aborted) return;
          session.status = "error";
          session.error = err.message;
          session.updatedAt = Date.now();
          this.scheduleSessionsRefresh();
          if (renderGhost()) this.clearGhostInView(view);
          if (session.inline && this.isViewActive(view)) this.popup.hide();
          new Notice(`LLM completion failed (${session.title}): ${err.message}`, 10000);
        },
      },
      ac.signal
    );
  }

  private runPreviewCompletion(session: CompletionSession, view: EditorView, pos: number, ac: AbortController) {
    const card = new PreviewCard(this.app, {
      onAccept: (completion) => {
        session.completion = completion;
        this.preview = null;
        void this.acceptSession(session.id);
      },
      onReject: () => {
        this.preview = null;
        this.cancelSession(session.id);
        this.removeSession(session.id);
      },
    });
    this.preview = card;
    card.open();

    try {
      const payload = this.service.buildPayload(session.params, this.settings.stream);
      card.setPromptPayload(payload.messages as unknown as import("./previewCard").PromptMessage[], {
        model: payload.model,
        max_tokens: payload.max_tokens,
        temperature: payload.temperature,
        stream: payload.stream,
        stream_options: payload.stream_options,
      });
    } catch (err) {
      console.warn("buildPayload failed", err);
    }

    this.service.complete(
      session.params,
      {
        onThinkingDelta: (delta) => {
          if (ac.signal.aborted) return;
          session.thinking += delta;
          session.updatedAt = Date.now();
          this.scheduleSessionsRefresh();
          card.appendThinking(delta);
        },
        onCompletionDelta: (delta) => {
          if (ac.signal.aborted) return;
          session.completion += delta;
          session.updatedAt = Date.now();
          this.scheduleSessionsRefresh();
          card.appendCompletion(delta);
        },
        onRestart: () => {
          if (ac.signal.aborted) return;
          session.completion = "";
          card.restartCompletion();
        },
        onDone: (completion, thinking, cacheUsage) => {
          if (ac.signal.aborted) return;
          session.completion = completion;
          session.thinking = thinking || session.thinking;
          session.cacheUsage = cacheUsage;
          session.status = "done";
          session.updatedAt = Date.now();
          this.recordCacheUsage(cacheUsage);
          this.scheduleSessionsRefresh();
          if (completion) card.setCompletion(completion);
          card.setCacheUsage(cacheUsage);
          card.finish();
        },
        onError: (err) => {
          if (ac.signal.aborted) return;
          session.status = "error";
          session.error = err.message;
          session.updatedAt = Date.now();
          this.scheduleSessionsRefresh();
          card.showError(err.message);
        },
      },
      ac.signal
    );
  }

  private activeEditorView(): EditorView | null {
    const ae = this.app.workspace.activeEditor;
    return (ae?.editor as unknown as { cm?: EditorView } | undefined)?.cm ?? null;
  }

  private canReuseEditor(session: CompletionSession): boolean {
    if (!session.editor || !session.view) return false;
    try {
      // Hidden/detached editor views remain valid targets; accept falls back to
      // direct file insertion if this throws (destroyed view) or the doc changed.
      return session.view.state.doc === session.doc;
    } catch {
      return false;
    }
  }

  /** Insert text into the target file at a character offset (used when the original editor is gone). */
  private async insertIntoFile(path: string, offset: number, text: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Cannot insert: ${path} was not found`);
      return false;
    }
    try {
      await this.app.vault.process(file, (data) => {
        const at = Math.max(0, Math.min(offset, data.length));
        return data.slice(0, at) + text + data.slice(at);
      });
      return true;
    } catch (err) {
      new Notice(`Cannot insert into ${file.basename}: ${(err as Error).message}`);
      return false;
    }
  }

  async acceptSession(id: string): Promise<void> {
    const session = this.findSession(id);
    if (!session || !session.completion) return;
    const text = session.completion;
    let inserted = false;
    if (this.canReuseEditor(session) && session.editor) {
      try {
        const editor = session.editor;
        editor.replaceRange(text, editor.offsetToPos(session.anchorOffset), editor.offsetToPos(session.anchorOffset));
        editor.setCursor(editor.offsetToPos(session.anchorOffset + text.length));
        inserted = true;
      } catch {
        inserted = false;
      }
    }
    if (!inserted && session.filePath) {
      inserted = await this.insertIntoFile(session.filePath, session.anchorOffset, text);
    }
    if (!inserted) return;
    if (session.view) this.clearGhostInView(session.view);
    this.popup.hide();
    this.removeSession(id);
  }

  async openSessionNote(id: string): Promise<void> {
    const session = this.findSession(id);
    if (!session?.filePath) return;
    const file = this.app.vault.getAbstractFileByPath(session.filePath);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  retrySession(id: string): void {
    const session = this.findSession(id);
    if (!session?.editor || !session.view) {
      new Notice("Cannot retry: the original editor is closed");
      return;
    }
    const editor = session.editor;
    const view = session.view;
    const instruction = session.params.instruction ?? "";
    const maxWords = session.params.maxWords;
    this.removeSession(id);
    void this.triggerCompletion(editor, view, instruction, maxWords);
  }

  /** Assembled messages for a session (sidebar prompt preview). */
  sessionPrompt(session: CompletionSession): { role: string; content: string }[] | null {
    try {
      return this.service.buildPayload(session.params, this.settings.stream).messages;
    } catch {
      return null;
    }
  }

  private accept(view?: EditorView) {
    const v = view ?? this.activeEditorView();
    if (!v) return;
    const ghost = getGhost(v.state);
    if (!ghost) return;
    const session = this.sessions.find((s) => s.view === v);
    if (session) {
      if (session.completion) void this.acceptSession(session.id);
      return;
    }
    const editor = this.editorForView(v);
    if (!editor) return;
    this.clearGhostInView(v);
    this.popup.hide();
    // Insert at the suggestion anchor, not wherever the cursor currently is.
    editor.replaceRange(ghost.text, editor.offsetToPos(ghost.pos), editor.offsetToPos(ghost.pos));
    editor.setCursor(editor.offsetToPos(ghost.pos + ghost.text.length));
  }

  private dismiss(view?: EditorView) {
    const v = view ?? this.activeEditorView();
    const target = v
      ? this.runningSessionForView(v) ?? this.sessions.find((s) => s.view === v) ?? this.newestRunningSession()
      : this.newestRunningSession();
    if (this.preview) {
      this.preview.close();
      this.preview = null;
    }
    if (target) {
      if (target.view) this.clearGhostInView(target.view);
      this.cancelSession(target.id);
    }
    if (v) this.clearGhostInView(v);
    this.popup.hide();
  }

  /**
   * In-note summary: summarize the selected paragraph(s) and append the result
   * right after them as `> [Summary] …`.
   */
  private async generateInNoteSummary(editor: Editor): Promise<void> {
    if (!editor.somethingSelected()) {
      new Notice("Select the paragraph(s) to summarize first");
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const lineFrom = { line: from.line, ch: 0 };
    const lineTo = { line: to.line, ch: editor.getLine(to.line).length };
    const text = editor.getRange(lineFrom, lineTo).trim();
    if (!text) {
      new Notice("Select the paragraph(s) to summarize first");
      return;
    }

    const ac = new AbortController();
    new Notice("Generating in-note summary…");
    const rec = this.beginSummaryOp("in-note-summary", text.slice(0, 40) + (text.length > 40 ? "…" : ""));
    try {
      const summary = await this.summaryService.generateForText(text, ac.signal, {
        systemPrompt: this.settings.inNoteSummaryPrompt || DEFAULT_NOVEL_SUMMARY_PROMPT_EN,
        maxWords: this.settings.summaryMaxWords,
      });
      if (ac.signal.aborted) {
        this.finishSummaryOp(rec, "failed", "cancelled");
        return;
      }
      const oneLiner = summary.replace(/\s*\r?\n\s*/g, " ").trim();
      const snippet = `\n\n> [Summary] ${oneLiner}`;
      editor.replaceRange(snippet, lineTo, lineTo);
      const endOffset = editor.posToOffset(lineTo) + snippet.length;
      editor.setCursor(editor.offsetToPos(endOffset));
      this.finishSummaryOp(rec, "success", "inserted after paragraph");
      new Notice("Summary added after paragraph.");
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === "AbortError") {
        this.finishSummaryOp(rec, "failed", "cancelled");
        return;
      }
      console.error("[ghostwriter] in-note summary failed", err);
      this.finishSummaryOp(rec, "failed", (err as Error).message);
      new Notice(`In-note summary failed: ${(err as Error).message}`, 10000);
    }
  }

  private regenerate() {
    const view = this.activeEditorView() ?? this.sessions.find((s) => s.view)?.view ?? null;
    if (!view) return;
    const session =
      this.sessions.find((s) => s.view === view) ??
      this.findSession(this.activeSessionId ?? "") ??
      this.sessions.find((s) => s.status === "done");
    const editor = session?.editor ?? null;
    if (!editor) return;
    const instruction = session?.params.instruction ?? "";
    const maxWords = session?.params.maxWords;
    // Replace the previous suggestion for this view with a fresh session.
    for (const s of this.sessions.filter(
      (x) => x.view === view && x.status !== "running" && x.status !== "preparing"
    )) {
      this.removeSession(s.id);
    }
    this.clearGhostInView(view);
    this.popup.hide();
    void this.triggerCompletion(editor, view, instruction, maxWords);
  }
}
