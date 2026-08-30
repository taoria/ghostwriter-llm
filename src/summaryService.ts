import { App, Notice, TFile, TFolder, Vault, requestUrl } from "obsidian";
import { GhostwriterSettings, DEFAULT_SUMMARY_SYSTEM_PROMPT } from "./settings";
import { apiError, parseSSEBody } from "./completionService";

export interface SummaryEntry {
  path: string;
  summaryFilePath: string;
  title: string;
  summary: string;
}

const SUMMARY_FILE_RE = /^summary-(\d+)\.md$/i;

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/")) base = base.slice(0, -1);
  if (path.startsWith("/")) path = path.slice(1);
  return `${base}/${path}`;
}

export class SummaryService {
  constructor(private app: App, private settings: () => GhostwriterSettings) {}

  private folderPath(): string {
    const configured = (this.settings().summaryFolder ?? "").trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return configured || "summaries";
  }

  private isSummaryFile(file: TFile): boolean {
    const folder = this.folderPath();
    return file.path.startsWith(`${folder}/`) && SUMMARY_FILE_RE.test(file.name);
  }

  private summaryFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isSummaryFile(file));
  }

  private parseSummaryFile(content: string, fallbackTitle: string): { source: string; summary: string; title: string } | null {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) return null;
    const sourceLine = frontmatter[1].match(/^source:\s*(.+)\s*$/m);
    if (!sourceLine) return null;
    let source = sourceLine[1].trim();
    if (source.startsWith('"') && source.endsWith('"')) {
      try {
        source = JSON.parse(source);
      } catch {
        source = source.slice(1, -1);
      }
    } else if (source.startsWith("'") && source.endsWith("'")) {
      source = source.slice(1, -1).replace(/''/g, "'");
    }
    source = source.replace(/^\/+/, "");
    const summary = content.slice(frontmatter[0].length).trim();
    if (!source || !summary) return null;
    const title = source.split("/").pop()?.replace(/\.md$/i, "") || fallbackTitle;
    return { source, summary, title };
  }

  private async readEntry(file: TFile): Promise<SummaryEntry | null> {
    try {
      const parsed = this.parseSummaryFile(await this.app.vault.cachedRead(file), file.basename);
      return parsed
        ? { path: parsed.source, summaryFilePath: file.path, title: parsed.title, summary: parsed.summary }
        : null;
    } catch {
      return null;
    }
  }

  /** Scan managed summary files only. Summary files live outside the notes they describe. */
  async collectAll(limit: number): Promise<SummaryEntry[]> {
    const vault: Vault = this.app.vault;
    const files = this.summaryFiles().slice(0, Math.max(0, limit));
    const entries: SummaryEntry[] = [];
    for (const f of files) {
      const entry = await this.readEntry(f);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async findForFile(file: TFile): Promise<SummaryEntry | null> {
    for (const summaryFile of this.summaryFiles()) {
      const entry = await this.readEntry(summaryFile);
      if (entry?.path === file.path) return entry;
    }
    return null;
  }

  /**
   * Rewrite the frontmatter `source:` of every managed summary for which the
   * callback returns a new path (null/undefined = leave untouched).
   * Used to keep summaries associated with notes across renames/moves.
   * Returns how many files were updated.
   */
  async renameSources(map: (sourcePath: string) => string | null): Promise<number> {
    let changed = 0;
    for (const f of this.summaryFiles()) {
      const entry = await this.readEntry(f);
      if (!entry) continue;
      const next = map(entry.path);
      if (!next || next === entry.path) continue;
      try {
        await this.app.vault.process(f, (data) => {
          const m = data.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
          if (!m) return data;
          const fm = m[0].replace(/^source:\s*.*$/m, `source: ${JSON.stringify(next)}`);
          if (fm === m[0]) return data;
          return fm + data.slice(m[0].length);
        });
        changed++;
      } catch {
        // Leave this file alone; it can be fixed by regenerating the summary.
      }
    }
    return changed;
  }

  /** Generate a summary only when explicitly requested, writing a separate summary-N file. Throws with a readable reason on failure. */
  async regenerate(file: TFile, signal: AbortSignal): Promise<string | null> {
    const content = await this.app.vault.read(file);
    const summary = await this.generateForText(content, signal);
    if (signal.aborted || !summary) return null;
    try {
      const existing = await this.findSummaryFile(file.path);
      const path = existing?.path ?? await this.nextSummaryPath();
      const output = formatSummaryFile(file.path, summary);
      if (existing) {
        await this.app.vault.modify(existing, output);
      } else {
        await this.app.vault.create(path, output);
      }
    } catch (err) {
      new Notice(`Failed to save summary file: ${(err as Error).message}`);
    }
    return summary;
  }

  private async findSummaryFile(sourcePath: string): Promise<TFile | null> {
    for (const file of this.summaryFiles()) {
      const entry = await this.readEntry(file);
      if (entry?.path === sourcePath) return file;
    }
    return null;
  }

  private async nextSummaryPath(): Promise<string> {
    const folder = this.folderPath();
    await this.ensureFolder(folder);
    const used = new Set<number>();
    for (const file of this.summaryFiles()) {
      const match = file.name.match(SUMMARY_FILE_RE);
      if (match) used.add(Number(match[1]));
    }
    let number = 1;
    while (used.has(number)) number++;
    return `${folder}/summary-${number}.md`;
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`Summary path is not a folder: ${current}`);
      }
    }
  }

  /**
   * Summarize arbitrary text with the summary model. Throws with a readable reason on failure.
   * Used for both note summaries (regenerate) and Novel-mode in-note paragraph summaries.
   */
  async generateForText(
    text: string,
    signal: AbortSignal,
    opts?: { systemPrompt?: string; maxWords?: number }
  ): Promise<string> {
    const s = this.settings();
    if (!s.summaryModel) throw new Error("No summary model configured (Settings → Summary recall → Summary model)");
    if (!s.apiBaseUrl) throw new Error("No API Base URL configured");
    const url = joinUrl(s.apiBaseUrl, "chat/completions");
    const maxWords = opts?.maxWords ?? s.summaryMaxWords;
    const sys = (opts?.systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT).replace(/\{max_words\}/g, String(maxWords));
    const noteText = text.slice(0, Math.max(s.summaryInputChars, 100));
    const timeoutSec = Math.max(5, Math.floor(Number(s.requestTimeoutSec ?? 120) || 120));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (s.apiKey) headers["Authorization"] = `Bearer ${s.apiKey}`;

    // Streamed like completions: some providers reject non-streamed requests whose
    // body contains typographic quotes (HTTP 500), and SSE is the reliable path.
    const attempt = async (maxTokens: number): Promise<{ text: string; finishReason: string }> => {
      const body = JSON.stringify({
        model: s.summaryModel,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: noteText },
        ],
        max_tokens: maxTokens,
        temperature: s.summaryTemperature,
        stream: true,
      });
      const reqPromise = requestUrl({ url, method: "POST", headers, contentType: "application/json", body, throw: false });
      const resp = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => reject(new Error(`Summary request timed out after ${timeoutSec}s`)), timeoutSec * 1000);
        reqPromise.then(
          (r) => {
            signal.removeEventListener("abort", onAbort);
            clearTimeout(timer);
            resolve({ status: r.status, text: r.text });
          },
          (e) => {
            signal.removeEventListener("abort", onAbort);
            clearTimeout(timer);
            reject(e);
          }
        );
      });
      if (resp.status < 200 || resp.status >= 300) throw apiError(resp.status, resp.text);
      let text = "";
      let finishReason = "";
      for (const ev of parseSSEBody(resp.text)) {
        if (ev.delta) text += ev.delta;
        if (ev.finishReason) finishReason = ev.finishReason;
      }
      return { text: text.trim(), finishReason };
    };

    let maxTokens = Math.max(64, Math.floor(Number(s.summaryMaxTokens) || 200));
    let result = await attempt(maxTokens);
    // Reasoning models can burn the whole token budget on thinking and return empty content.
    while (!result.text && result.finishReason === "length" && maxTokens < 8192) {
      maxTokens = Math.min(8192, maxTokens * 4);
      console.warn(`[ghostwriter] summary empty (finish_reason=length); retrying with max_tokens=${maxTokens}`);
      result = await attempt(maxTokens);
    }
    if (!result.text) {
      throw new Error(
        `Summary model returned empty content (finish_reason: ${result.finishReason || "unknown"}). Raise "Summary max tokens" or choose a non-reasoning summary model.`
      );
    }
    return result.text;
  }
}

function formatSummaryFile(sourcePath: string, summary: string): string {
  return `---\nsource: ${JSON.stringify(sourcePath)}\n---\n\n${summary.trim()}\n`;
}
