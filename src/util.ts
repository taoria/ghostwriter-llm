import { Editor, EditorPosition } from "obsidian";

export interface ContextStrings {
  prefix: string;
  suffix: string;
}

export function getPrefixSuffix(
  editor: Editor,
  prefixChars: number,
  suffixChars: number
): ContextStrings {
  const cursor: EditorPosition = editor.getCursor();
  const from: EditorPosition = { line: 0, ch: 0 };
  const to: EditorPosition = { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length };

  const fullText = editor.getRange(from, to);
  const offset = editor.posToOffset(cursor);

  const start = Math.max(0, offset - prefixChars);
  const end = Math.min(fullText.length, offset + suffixChars);

  return {
    prefix: fullText.slice(start, offset),
    suffix: fullText.slice(offset, end),
  };
}

export function ensureTrailingNewline(s: string): string {
  if (!s) return s;
  return s.endsWith("\n") ? s : s + "\n";
}

/**
 * Matches an in-note summary marker anywhere in a line: `> [Summary] …`,
 * `text > [Summary] …`, `[Summary] …`, `【摘要】…` etc. (case-insensitive).
 * Group 1 = any text before the marker on the same line, group 2 = summary text.
 */
export const IN_NOTE_SUMMARY_LINE_RE = /^(.*?)>?\s*(?:\[(?:Summary|摘要)\]|【(?:Summary|摘要)】)\s*(.*)$/i;

export interface InNoteParseResult {
  /** Summary texts in document order (quote markers stripped, joined to one line each). */
  summaries: string[];
  /** Raw text after the last summary block (or the whole text when none found). */
  tail: string;
  hasAny: boolean;
}

/**
 * Split a text into its in-note summary blocks and the raw remainder.
 * A summary block starts at a `[Summary]` / `[摘要]` marker (start of line,
 * after a quote `>`, or inline after text); consecutive quote lines continue
 * the block. Text on the same line before the marker counts as covered text.
 */
export function parseInNoteSummaries(text: string): InNoteParseResult {
  const lines = text.split("\n");
  const summaries: string[] = [];
  let lastSummaryEnd = -1;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(IN_NOTE_SUMMARY_LINE_RE);
    if (m) {
      const parts: string[] = [];
      const first = m[2].trim();
      if (first) parts.push(first);
      i++;
      // Consume consecutive quote lines into the same summary block,
      // but stop when the line starts its own summary marker.
      while (
        i < lines.length &&
        /^>\s?/.test(lines[i]) &&
        !IN_NOTE_SUMMARY_LINE_RE.test(lines[i])
      ) {
        const cont = lines[i].replace(/^>\s?/, "").trim();
        if (cont) parts.push(cont);
        i++;
      }
      if (parts.length) summaries.push(parts.join(" "));
      lastSummaryEnd = i;
      continue;
    }
    i++;
  }
  const tail = lastSummaryEnd >= 0 ? lines.slice(lastSummaryEnd).join("\n") : text;
  return { summaries, tail, hasAny: summaries.length > 0 };
}
