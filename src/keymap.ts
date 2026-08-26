import { Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, KeyBinding } from "@codemirror/view";
import { getGhost } from "./ghostText";

export interface GhostKeyHandlers {
  onAccept: (view: EditorView) => void;
  onDismiss: (view: EditorView) => void;
  /** True while a completion is generating; allows dismissal keys to cancel even without ghost text. */
  isBusy?: () => boolean;
}

const KEY_ALIASES: Record<string, string> = {
  tab: "Tab",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function normalizeKeyName(name: string): string {
  const lower = name.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (lower === "escape") return "Escape";
  if (lower === "esc") return "Escape";
  if (name.length === 1) return name.toUpperCase();
  return name;
}

/** Normalize a configured key spec into a canonical name (e.g. "Tab", "Ctrl-Enter", "Shift-Escape"). */
export function normalizeKey(raw: string): string {
  const trimmed = (raw ?? "").trim().replace(/\s*\+\s*/g, "+").replace(/\s+/g, " ");
  if (!trimmed) return "";
  const parts = trimmed.split(/[-+]/).filter(Boolean);
  if (parts.length === 0) return "";
  const last = normalizeKeyName(parts[parts.length - 1]);
  const mods = parts.slice(0, -1);
  const normalizedMods = mods.map((m) => {
    const lower = m.toLowerCase();
    if (lower === "ctrl" || lower === "control") return "Ctrl";
    if (lower === "shift") return "Shift";
    if (lower === "alt") return "Alt";
    if (lower === "mod" || lower === "cmd" || lower === "meta") return "Mod";
    return m;
  });
  return [...normalizedMods, last].join("-");
}

export function parseKeys(raw: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((k) => normalizeKey(k))
    .filter(Boolean);
}

/** Map a KeyboardEvent to a canonical key name like "Ctrl-Enter" or "Shift-Tab". */
export function eventToKeyName(e: KeyboardEvent): string {
  const key = e.key;
  let name: string;
  if (key === " ") name = "Space";
  else if (key === "Tab") name = "Tab";
  else if (key === "Enter") name = "Enter";
  else if (key === "Escape") name = "Escape";
  else if (key === "Backspace") name = "Backspace";
  else if (key.length === 1) name = key.toUpperCase();
  else name = key;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.metaKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && name !== "Shift") mods.push("Shift");
  return mods.length ? [...mods, name].join("-") : name;
}

const ACCEPT_COMBOS = ["Tab", "Shift-Tab", "Enter", "Shift-Enter", "Shift-Insert", "Ctrl-Enter", "Alt-Enter", "Mod-Enter"];
const DISMISS_COMBOS = ["Escape", "Shift-Escape", "Ctrl-Escape"];

export function ghostKeymap(
  handlers: GhostKeyHandlers,
  getKeys: () => { accept: string; dismiss: string }
): Extension {
  const bindings: KeyBinding[] = [];
  for (const combo of ACCEPT_COMBOS) {
    bindings.push({
      key: combo,
      preventDefault: true,
      run: (view: EditorView): boolean => {
        const acceptKeys = parseKeys(getKeys().accept);
        if (!acceptKeys.includes(combo)) return false;
        if (!getGhost(view.state)) return false;
        handlers.onAccept(view);
        return true;
      },
    });
  }
  for (const combo of DISMISS_COMBOS) {
    bindings.push({
      key: combo,
      preventDefault: true,
      run: (view: EditorView): boolean => {
        const dismissKeys = parseKeys(getKeys().dismiss);
        if (!dismissKeys.includes(combo)) return false;
        if (!getGhost(view.state) && !(handlers.isBusy?.() ?? false)) return false;
        handlers.onDismiss(view);
        return true;
      },
    });
  }

  const domHandler = EditorView.domEventHandlers({
    keydown: (event: KeyboardEvent, view: EditorView) => {
      const ghost = getGhost(view.state);
      const busy = handlers.isBusy?.() ?? false;
      if (!ghost && !busy) return false;
      const acceptKeys = parseKeys(getKeys().accept);
      const dismissKeys = parseKeys(getKeys().dismiss);
      const name = eventToKeyName(event);
      if (dismissKeys.includes(name)) {
        if (DISMISS_COMBOS.includes(name)) return false;
        event.preventDefault();
        handlers.onDismiss(view);
        return true;
      }
      if (ghost && acceptKeys.includes(name)) {
        if (ACCEPT_COMBOS.includes(name)) return false;
        event.preventDefault();
        handlers.onAccept(view);
        return true;
      }
      return false;
    },
  });

  return [Prec.high(keymap.of(bindings)), domHandler];
}
