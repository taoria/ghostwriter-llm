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

/** Matches an in-note summary line: `> [Summary] …` or `> [摘要] …` (case-insensitive). */
export const IN_NOTE_SUMMARY_LINE_RE = /^>\s*\[(?:Summary|摘要)\]\s*(.*)$/i;

export interface InNoteParseResult {
  /** Summary texts in document order (quote markers stripped, joined to one line each). */
  summaries: string[];
  /** Raw text after the last summary block (or the whole text when none found). */
  tail: string;
  hasAny: boolean;
}

/**
 * Split a text into its in-note summary blocks and the raw remainder.
 * A summary block is a blockquote whose first line matches
 * `> [Summary]` / `> [摘要]`; consecutive quote lines continue the block.
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
      const first = m[1].trim();
      if (first) parts.push(first);
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
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
