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
