import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { EditorState, StateField, StateEffect, Transaction, Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

export interface GhostState {
  text: string;
  pos: number;
}

export const setGhostEffect = StateEffect.define<GhostState>();
export const clearGhostEffect = StateEffect.define<null>();

export const emptyGhost: GhostState | null = null;

export const ghostField = StateField.define<GhostState | null>({
  create() {
    return null;
  },
  update(value, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setGhostEffect)) {
        return e.value;
      }
      if (e.is(clearGhostEffect)) {
        return null;
      }
    }
    if (value && tr.docChanged) {
      return null;
    }
    if (value && tr.selection) {
      const head = tr.selection.main.head;
      if (head !== value.pos) return null;
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => buildDecorations(v)),
});

function buildDecorations(state: GhostState | null): DecorationSet {
  if (!state || !state.text) return Decoration.none;
  const widget = new GhostWidget(state.text);
  const deco = Decoration.widget({ widget, side: 1 });
  return Decoration.set([deco.range(state.pos)]);
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "llm-ghost";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export function getGhost(state: EditorState): GhostState | null {
  return state.field(ghostField, false) ?? null;
}

export const ghostExtension: Extension = [ghostField];
