import { Plugin, Notice, Editor, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DEFAULT_SETTINGS, GhostwriterSettings } from "./settings";
import { GhostwriterSettingTab } from "./settingsTab";
import { CacheUsage, CompletionService, CompletionParams, formatCacheUsage } from "./completionService";
import { clearGhostEffect, getGhost, ghostExtension, setGhostEffect, GhostState } from "./ghostText";
import { ghostKeymap } from "./keymap";
import { getPrefixSuffix } from "./util";
import { GhostPopup } from "./popup";
import { PreviewCard } from "./previewCard";
import { SummaryService, SummaryEntry } from "./summaryService";

export default class GhostwriterPlugin extends Plugin {
  settings!: GhostwriterSettings;
  private service!: CompletionService;
  private summaryService!: SummaryService;
  private popup!: GhostPopup;
  private preview: PreviewCard | null = null;
  private currentAbort: AbortController | null = null;
  private currentParams: CompletionParams | null = null;
  private currentView: EditorView | null = null;
  private currentEditor: Editor | null = null;
  private currentPos: number = 0;
  private generating: boolean = false;
  private sessionSummaryOn: boolean = true;
  private statusBarEl: HTMLElement | null = null;
  private currentSummaryStatusBarEl: HTMLElement | null = null;
  private cacheStatusBarEl: HTMLElement | null = null;
  private lastCacheUsage: CacheUsage | undefined;
  private cacheUsageKnown: boolean = false;

  async onload() {
    await this.loadSettings();

    this.service = new CompletionService(() => this.settings);
    this.summaryService = new SummaryService(this.app, () => this.settings);
    this.popup = new GhostPopup({
      onRegenerate: () => this.regenerate(),
      onDismiss: () => this.dismiss(),
    });

    this.registerEditorExtension([ghostExtension, ghostKeymap({
      onAccept: () => this.accept(),
      onDismiss: () => this.dismiss(),
    }, () => ({
      accept: this.settings.acceptKey,
      dismiss: this.settings.dismissKey,
    }))]);

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
      id: "dismiss-llm-completion",
      name: "Dismiss current LLM suggestion",
      editorCallback: () => {
        this.dismiss();
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
        this.currentAbort = ac;
        try {
          const summary = await this.summaryService.regenerate(f, ac.signal);
          if (summary) {
             new Notice("Summary saved.");
          } else {
            new Notice("Summary generation failed.");
          }
        } catch (err) {
          new Notice(`Summary generation error: ${(err as Error).message}`);
        } finally {
          this.currentAbort = null;
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.dismiss();
        this.updateStatusBar();
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

    this.addSettingTab(new GhostwriterSettingTab(this.app, this));
  }

  onunload() {
    this.popup?.destroy();
    this.preview?.close();
    this.abortCurrent();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private getViewFromEditor(editor: Editor): EditorView | null {
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    return cm ?? null;
  }

  private abortCurrent() {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.generating = false;
  }

  private clearGhostInView(view: EditorView) {
    view.dispatch({ effects: clearGhostEffect.of(null) });
  }

  private setGhostInView(view: EditorView, state: GhostState) {
    view.dispatch({ effects: setGhostEffect.of(state) });
  }

  private getActiveNoteTitle(): string {
    const file = this.app.workspace.getActiveFile();
    if (!file) return "";
    const name = file.basename ?? file.name ?? "";
    return name.replace(/\.md$/i, "");
  }

  private async triggerCompletion(editor: Editor, view: EditorView) {
    if (this.generating) {
      this.abortCurrent();
      this.clearGhostInView(view);
    }
    this.preview?.close();
    this.preview = null;

    const cursorPos0 = view.state.selection.main.head;
    this.popup.showLoading(view, cursorPos0);

    const ac = new AbortController();
    this.currentAbort = ac;
    this.generating = true;
    this.resetCacheStatus();

    const summaryOn = this.sessionSummaryOn && this.settings.summaryEnabled;
    let summary = "";
    if (summaryOn) {
      try {
        summary = await this.buildSummaryContext(ac.signal);
      } catch (err) {
        console.warn("summary build failed", err);
      }
    }
    if (ac.signal.aborted) {
      this.popup.hide();
      return;
    }

    const title = this.getActiveNoteTitle();
    const { prefix, suffix } = getPrefixSuffix(editor, this.settings.prefixChars, this.settings.suffixChars);
    const params: CompletionParams = {
      prefix,
      suffix,
      summary,
      title,
    };

    this.currentParams = params;
    this.currentView = view;
    this.currentEditor = editor;
    const cursorPos = view.state.selection.main.head;
    this.currentPos = cursorPos;

    if (this.settings.previewMode) {
      this.popup.hide();
      this.runPreviewCompletion(params, view, cursorPos, ac);
    } else {
      this.popup.showLoading(view, cursorPos);
      this.runInlineCompletion(params, view, cursorPos, ac);
    }
  }

  private async buildSummaryContext(signal: AbortSignal): Promise<string> {
    const s = this.settings;
    const file = this.app.workspace.getActiveFile();
    const parts: string[] = [];

    if (file instanceof TFile && file.path.toLowerCase().endsWith(".md")) {
      try {
        const activeSummary = await this.summaryService.findForFile(file);
        if (signal.aborted) return "";
        if (activeSummary && activeSummary.summaryFilePath !== file.path && this.isSummaryEnabled(activeSummary.path)) {
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
      (e) => !(file instanceof TFile) || (e.path !== file.path && e.summaryFilePath !== file.path)
    );
    others.sort((a, b) => a.title.localeCompare(b.title));
    for (const e of others) {
      if (this.isSummaryEnabled(e.path)) {
        parts.push(`[Summary: ${e.title}]\n${e.summary}`);
      }
    }

    const manual = (s.summary ?? "").trim();
    if (manual) {
      parts.push(`[Manual summary]\n${manual}`);
    }

    return parts.join("\n\n");
  }

  private isSummaryEnabled(sourcePath: string): boolean {
    return !(this.settings.summaryDisabledPaths ?? []).includes(sourcePath);
  }

  private async toggleCurrentSummary(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !file.path.toLowerCase().endsWith(".md")) {
      new Notice("No active Markdown note");
      return;
    }

    const disabledPaths = this.settings.summaryDisabledPaths ?? [];
    const disabled = disabledPaths.includes(file.path);
    this.settings.summaryDisabledPaths = disabled
      ? disabledPaths.filter((path) => path !== file.path)
      : [...disabledPaths, file.path];
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

  private completionContextIsCurrent(view: EditorView, pos: number, ac: AbortController, doc: typeof view.state.doc): boolean {
    if (ac.signal.aborted || this.currentAbort !== ac || this.currentView !== view) return false;
    if (view.state.selection.main.head === pos && view.state.doc === doc) return true;
    ac.abort();
    this.generating = false;
    if (this.currentAbort === ac) this.currentAbort = null;
    this.clearGhostInView(view);
    this.popup.hide();
    return false;
  }

  private runInlineCompletion(params: CompletionParams, view: EditorView, pos: number, ac: AbortController) {
    const peek = this.settings.peekCoT;
    const sourceDoc = view.state.doc;

    let accumulated = "";

    this.service.complete(
      params,
      {
        onThinkingDelta: peek ? (delta) => {
          if (ac.signal.aborted) return;
          this.popup.appendThinking(delta);
        } : undefined,
        onCompletionDelta: (delta) => {
          if (!this.completionContextIsCurrent(view, pos, ac, sourceDoc)) return;
          accumulated += delta;
          this.setGhostInView(view, { text: accumulated, pos });
        },
        onDone: (completion, _thinking, cacheUsage) => {
          if (!this.completionContextIsCurrent(view, pos, ac, sourceDoc)) return;
          this.recordCacheUsage(cacheUsage);
          this.generating = false;
          this.currentAbort = null;
          if (completion) {
            this.setGhostInView(view, { text: completion, pos });
            this.popup.showActions(view, pos);
          } else {
            this.clearGhostInView(view);
            this.popup.hide();
          }
        },
        onError: (err) => {
          if (ac.signal.aborted) return;
          this.generating = false;
          this.currentAbort = null;
          this.clearGhostInView(view);
          this.popup.hide();
          new Notice(`LLM completion failed: ${err.message}`);
        },
      },
      ac.signal
    );
  }

  private runPreviewCompletion(params: CompletionParams, view: EditorView, pos: number, ac: AbortController) {
    const card = new PreviewCard(this.app, {
      onAccept: (completion) => {
        this.insertAtCursor(completion);
        this.abortCurrent();
        this.currentParams = null;
      },
      onReject: () => {
        this.abortCurrent();
        this.currentParams = null;
      },
    });
    this.preview = card;
    card.open();

    try {
      const payload = this.service.buildPayload(params, this.settings.stream);
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
      params,
      {
        onThinkingDelta: (delta) => {
          if (ac.signal.aborted) return;
          card.appendThinking(delta);
        },
        onCompletionDelta: (delta) => {
          if (ac.signal.aborted) return;
          card.appendCompletion(delta);
        },
        onDone: (completion, thinking, cacheUsage) => {
          if (ac.signal.aborted) return;
          this.recordCacheUsage(cacheUsage);
          this.generating = false;
          this.currentAbort = null;
          if (completion) card.setCompletion(completion);
          card.setCacheUsage(cacheUsage);
          card.finish();
        },
        onError: (err) => {
          if (ac.signal.aborted) return;
          this.generating = false;
          this.currentAbort = null;
          card.showError(err.message);
        },
      },
      ac.signal
    );
  }

  private insertAtCursor(text: string) {
    const editor = this.currentEditor;
    if (!editor) return;
    const pos = editor.posToOffset(editor.getCursor("head"));
    editor.replaceRange(text, editor.offsetToPos(pos), editor.offsetToPos(pos));
    const newPos = pos + text.length;
    editor.setCursor(editor.offsetToPos(newPos));
  }

  private accept() {
    const view = this.currentView;
    const editor = this.currentEditor;
    if (!view || !editor) return;
    const ghost = getGhost(view.state);
    if (!ghost) return;

    this.abortCurrent();
    const text = ghost.text;
    this.clearGhostInView(view);
    this.popup.hide();

    this.insertAtCursor(text);
  }

  private dismiss() {
    const view = this.currentView;
    if (this.preview) {
      this.preview.close();
      this.preview = null;
    }
    if (view) this.clearGhostInView(view);
    this.popup.hide();
    this.abortCurrent();
    this.currentParams = null;
  }

  private async regenerate() {
    const view = this.currentView;
    const editor = this.currentEditor;
    const params = this.currentParams;
    if (!view || !editor || !params) return;
    this.abortCurrent();
    this.clearGhostInView(view);
    const ac = new AbortController();
    this.currentAbort = ac;
    this.generating = true;
    this.resetCacheStatus();
    let summary = params.summary;
    if (this.sessionSummaryOn && this.settings.summaryEnabled) {
      try {
        summary = await this.buildSummaryContext(ac.signal);
      } catch (err) {
        console.warn("regenerate summary build failed", err);
      }
      if (ac.signal.aborted) {
        this.popup.hide();
        return;
      }
      params.summary = summary;
    }
    const cursorPos = view.state.selection.main.head;
    this.currentPos = cursorPos;
    const context = getPrefixSuffix(editor, this.settings.prefixChars, this.settings.suffixChars);
    params.prefix = context.prefix;
    params.suffix = context.suffix;
    params.title = this.getActiveNoteTitle();
    if (this.settings.previewMode) {
      this.runPreviewCompletion(params, view, cursorPos, ac);
    } else {
      this.popup.showLoading(view, cursorPos);
      this.runInlineCompletion(params, view, cursorPos, ac);
    }
  }
}
