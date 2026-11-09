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

/** Right-sidebar session manager: live preview + actions for every completion. */
export class SessionsView extends ItemView {
  private plugin: GhostwriterPlugin;
  /** Persisted <details> open state across re-renders. */
  private openDetails = new Set<string>();

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
    this.contentEl.addClass("ghostwriter-sessions-view");
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ghostwriter-sessions-view");

    const header = root.createDiv({ cls: "ghostwriter-sessions-header" });
    header.createSpan({ cls: "ghostwriter-sessions-title", text: "Background sessions" });
    const running = this.plugin.getSessions().filter((s) => s.status === "running" || s.status === "preparing").length;
    if (running) header.createSpan({ cls: "ghostwriter-sessions-running", text: `${running} running` });
    const clear = header.createEl("button", { cls: "ghostwriter-sessions-clear", text: "Clear finished" });
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      this.plugin.clearFinishedSessions();
    });

    const sessions = this.plugin.getSessions();
    if (!sessions.length) {
      root.createEl("p", {
        cls: "ghostwriter-sessions-empty",
        text: this.plugin.settings.backgroundMode
          ? "No sessions yet. Trigger a completion and switch notes freely — it keeps running here."
          : "No sessions yet. Enable Background mode to keep completions running when you switch notes.",
      });
      return;
    }

    const list = root.createDiv({ cls: "ghostwriter-sessions-list" });
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
