import { App, Notice, TFile, TFolder, Vault, requestUrl } from "obsidian";
import { GhostwriterSettings, DEFAULT_SUMMARY_SYSTEM_PROMPT } from "./settings";

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

  /** Generate a summary only when explicitly requested, writing a separate summary-N file. */
  async regenerate(file: TFile, signal: AbortSignal): Promise<string | null> {
    const content = await this.app.vault.read(file);
    const summary = await this.generate(file, content, signal);
    if (!summary) return null;
    if (signal.aborted) return null;
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

  /** Call the summary model with the note content, returning the trimmed text. */
  private async generate(file: TFile, content: string, signal: AbortSignal): Promise<string | null> {
    const s = this.settings();
    if (!s.summaryModel || !s.apiBaseUrl) return null;
    if (!s.summaryEnabled) return null;
    const url = joinUrl(s.apiBaseUrl, "chat/completions");
    const sys = DEFAULT_SUMMARY_SYSTEM_PROMPT.replace(/\{max_words\}/g, String(s.summaryMaxWords));
    const noteText = content.slice(0, Math.max(s.summaryInputChars, 100));
    const body = JSON.stringify({
      model: s.summaryModel,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: noteText },
      ],
      max_tokens: s.summaryMaxTokens,
      temperature: s.summaryTemperature,
      stream: false,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (s.apiKey) headers["Authorization"] = `Bearer ${s.apiKey}`;

    const reqPromise = requestUrl({
      url,
      method: "POST",
      headers,
      contentType: "application/json",
      body,
      throw: false,
    });

    return new Promise<string | null>((resolve) => {
      const onAbort = () => resolve(null);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      reqPromise.then(
        (r) => {
          signal.removeEventListener("abort", onAbort);
          if (r.status < 200 || r.status >= 300) {
            new Notice(`Summary API ${r.status}: ${r.text?.slice(0, 200) ?? "request failed"}`);
            resolve(null);
            return;
          }
          let text = "";
          try {
            const json = JSON.parse(r.text);
            text = json?.choices?.[0]?.message?.content ?? "";
          } catch {
            text = "";
          }
          resolve((text ?? "").trim());
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(null);
        }
      );
    });
  }
}

function formatSummaryFile(sourcePath: string, summary: string): string {
  return `---\nsource: ${JSON.stringify(sourcePath)}\n---\n\n${summary.trim()}\n`;
}
