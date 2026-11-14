import type { EditorView } from "@codemirror/view";
import type { Editor } from "obsidian";
import type { CacheUsage, CompletionParams } from "./completionService";

export type SessionStatus = "preparing" | "running" | "done" | "error" | "cancelled";

/**
 * One background completion request. Sessions outlive note switches (when
 * background mode is on) and are rendered/managed by the right-sidebar view.
 */
export interface CompletionSession {
  id: string;
  /** Target note path ("" when the completion was not tied to a file). */
  filePath: string;
  title: string;
  /** Name of the writing mode used at creation time. */
  modeName: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  params: CompletionParams;
  completion: string;
  thinking: string;
  error?: string;
  abort: AbortController;
  /** Originating editor view (may be closed later; never re-used if the doc changed). */
  view: EditorView | null;
  editor: Editor | null;
  /** Character offset of the cursor in the target note at creation time. */
  anchorOffset: number;
  /** Document reference at creation time, to detect edits to the target note. */
  doc: unknown;
  /** True when the suggestion is rendered as inline ghost text in `view`. */
  inline: boolean;
  /** The user dismissed the ghost; don't re-create it on note focus. */
  ghostDismissed?: boolean;
  cacheUsage?: CacheUsage;
}

export function makeSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function sessionElapsed(session: CompletionSession): string {
  const end = session.status === "done" || session.status === "error" || session.status === "cancelled"
    ? session.updatedAt
    : Date.now();
  const sec = Math.max(0, Math.round((end - session.createdAt) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
