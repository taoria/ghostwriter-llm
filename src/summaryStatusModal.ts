import { App, Modal } from "obsidian";
import type GhostwriterPlugin from "./main";

export type SummaryOpState = "running" | "success" | "failed";

export interface SummaryOpRecord {
  time: number;
  kind: "note-summary" | "in-note-summary";
  target: string;
  state: SummaryOpState;
  message: string;
}

interface SummaryFileRow {
  name: string;
  path: string;
  ok: boolean;
  source?: string;
  preview?: string;
  reason?: string;
}

export class SummaryStatusModal extends Modal {
  private plugin: GhostwriterPlugin;
  private timer: number | null = null;
  private rendering = false;

  constructor(app: App, plugin: GhostwriterPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass("gw-summary-status-modal");
    void this.render();
    this.timer = window.setInterval(() => void this.render(), 600);
  }

  onClose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.contentEl.empty();
  }

  private fmtTime(t: number): string {
    return new Date(t).toLocaleTimeString();
  }

  private async render(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      await this.renderInner();
    } catch (err) {
      console.warn("[ghostwriter] summary status render failed", err);
    } finally {
      this.rendering = false;
    }
  }

  private async renderInner(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Summary status" });

    // --- Current / last operation ---
    const ops = this.plugin.summaryOps;
    const running = ops.find((o) => o.state === "running");
    const opSection = contentEl.createDiv({ cls: "gw-sum-op" });
    opSection.createEl("h3", { text: "Operation" });

    if (running) {
      const row = opSection.createDiv({ cls: "gw-sum-op-row is-running" });
      row.createSpan({ text: "⟳", cls: "gw-sum-badge is-running" });
      const elapsed = Math.round((Date.now() - running.time) / 1000);
      row.createSpan({
        text: `${running.kind === "note-summary" ? "Note summary" : "In-note summary"} — ${running.target} (${elapsed}s)`,
      });
    } else if (ops.length > 0) {
      const last = ops[0];
      const row = opSection.createDiv({ cls: `gw-sum-op-row is-${last.state}` });
      row.createSpan({
        text: last.state === "success" ? "✓" : "✗",
        cls: `gw-sum-badge is-${last.state}`,
      });
      row.createSpan({
        text: `${last.state === "success" ? "Last succeeded" : "Last failed"}: ${last.kind === "note-summary" ? "Note summary" : "In-note summary"} — ${last.target}`,
      });
    } else {
      opSection.createEl("p", {
        text: "No summary generation yet this session.",
        cls: "setting-item-description",
      });
    }

    // --- Summary files ---
    contentEl.createEl("h3", { text: "Summary files" });
    const filesWrap = contentEl.createDiv({ cls: "gw-sum-files" });
    let rows: SummaryFileRow[] = [];
    try {
      const states = await this.plugin.summaryService.listFileStates(this.plugin.settings.summaryScanLimit);
      rows = states.map((st) => ({
        name: st.file.name,
        path: st.file.path,
        ok: !!st.entry,
        source: st.entry?.path,
        preview: st.entry?.summary?.slice(0, 240),
        reason: st.reason,
      }));
    } catch (err) {
      filesWrap.createEl("p", { text: `Failed to scan summary files: ${(err as Error).message}`, cls: "gw-sum-error" });
    }

    if (!rows.length) {
      filesWrap.createEl("p", {
        text: `No summary files found in "${this.plugin.settings.summaryFolder}".`,
        cls: "setting-item-description",
      });
    }

    for (const row of rows) {
      const item = filesWrap.createDiv({ cls: `gw-sum-file ${row.ok ? "is-ok" : "is-bad"}` });
      const head = item.createDiv({ cls: "gw-sum-file-head" });
      head.createSpan({
        text: row.ok ? "✓" : "✗",
        cls: `gw-sum-badge ${row.ok ? "is-success" : "is-failed"}`,
      });
      head.createSpan({ text: row.name, cls: "gw-sum-file-name" });
      if (row.ok) {
        const off =
          (this.plugin.settings.disabledSummaryFiles ?? []).includes(row.path) ||
          (row.source && (this.plugin.settings.summaryDisabledPaths ?? []).includes(row.source));
        if (off) head.createSpan({ text: "OFF", cls: "gw-sum-badge is-off" });
      } else {
        head.createSpan({ text: "NOT INJECTED", cls: "gw-sum-badge is-failed" });
      }
      if (row.ok && row.source) {
        item.createDiv({ text: `source: ${row.source}`, cls: "gw-sum-file-meta" });
      }
      if (row.ok && row.preview) {
        item.createDiv({ text: row.preview + (row.preview.length >= 240 ? "…" : ""), cls: "gw-sum-file-preview" });
      }
      if (!row.ok) {
        item.createDiv({
          text: `Cannot be previewed / injected: ${row.reason ?? "invalid format"}`,
          cls: "gw-sum-file-meta is-error",
        });
      }
    }

    // --- History ---
    contentEl.createEl("h3", { text: "Recent operations" });
    const histWrap = contentEl.createDiv({ cls: "gw-sum-history" });
    const recent = ops.slice(0, 12);
    if (!recent.length) {
      histWrap.createEl("p", { text: "—", cls: "setting-item-description" });
    }
    for (const op of recent) {
      const row = histWrap.createDiv({ cls: `gw-sum-hist-row is-${op.state}` });
      row.createSpan({ text: this.fmtTime(op.time), cls: "gw-sum-hist-time" });
      row.createSpan({
        text: op.state === "running" ? "⟳" : op.state === "success" ? "✓" : "✗",
        cls: `gw-sum-badge is-${op.state}`,
      });
      row.createSpan({
        text: `${op.kind === "note-summary" ? "note" : "in-note"} · ${op.target}`,
        cls: "gw-sum-hist-target",
      });
      if (op.message) {
        row.createSpan({ text: op.message, cls: "gw-sum-hist-msg" });
      }
    }

    const btns = contentEl.createDiv({ cls: "gw-sum-actions" });
    const refresh = btns.createEl("button", { text: "Refresh" });
    refresh.addEventListener("click", () => void this.render());
    const close = btns.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
  }
}
