import { EditorView } from "@codemirror/view";

export interface PopupCallbacks {
  onRegenerate: () => void;
  onDismiss: () => void;
}

export class GhostPopup {
  private el: HTMLElement | null = null;
  private spinnerEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private thinkingWrapEl: HTMLElement | null = null;
  private thinkingBodyEl: HTMLElement | null = null;
  private toggleEl: HTMLElement | null = null;
  private cb: PopupCallbacks;
  private thinkingExpanded: boolean = true;

  constructor(cb: PopupCallbacks) {
    this.cb = cb;
  }

  private ensureEl(view: EditorView): HTMLElement {
    if (this.el && document.body.contains(this.el)) return this.el;
    const el = document.createElement("div");
    el.className = "ghostwriter-popup";
    el.style.display = "none";
    el.setAttribute("data-ignore-external-click", "true");

    const thinkingWrap = document.createElement("div");
    thinkingWrap.className = "ghostwriter-popup-thinking";
    thinkingWrap.style.display = "none";
    const toggle = document.createElement("div");
    toggle.className = "ghostwriter-popup-thinking-toggle";
    toggle.setText("Thinking");
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      this.thinkingExpanded = !this.thinkingExpanded;
      if (this.thinkingBodyEl) {
        this.thinkingBodyEl.style.display = this.thinkingExpanded ? "" : "none";
      }
    });
    const thinkingBody = document.createElement("div");
    thinkingBody.className = "ghostwriter-popup-thinking-body";
    thinkingWrap.appendChild(toggle);
    thinkingWrap.appendChild(thinkingBody);
    el.appendChild(thinkingWrap);

    const spinner = document.createElement("div");
    spinner.className = "ghostwriter-popup-spinner";
    spinner.setText("Generating…");
    el.appendChild(spinner);

    const actions = document.createElement("div");
    actions.className = "ghostwriter-popup-actions";
    actions.style.display = "none";

    const regen = document.createElement("button");
    regen.className = "ghostwriter-popup-btn ghostwriter-popup-regen";
    regen.setText("Regenerate");
    regen.addEventListener("click", (e) => {
      e.preventDefault();
      this.cb.onRegenerate();
    });

    const dismiss = document.createElement("button");
    dismiss.className = "ghostwriter-popup-btn ghostwriter-popup-dismiss";
    dismiss.setText("Dismiss");
    dismiss.addEventListener("click", (e) => {
      e.preventDefault();
      this.cb.onDismiss();
    });

    actions.appendChild(regen);
    actions.appendChild(dismiss);
    el.appendChild(actions);

    document.body.appendChild(el);
    this.el = el;
    this.spinnerEl = spinner;
    this.actionsEl = actions;
    this.thinkingWrapEl = thinkingWrap;
    this.thinkingBodyEl = thinkingBody;
    this.toggleEl = toggle;
    return el;
  }

  showLoading(view: EditorView, pos: number): void {
    const el = this.ensureEl(view);
    this.spinnerEl!.style.display = "";
    this.actionsEl!.style.display = "none";
    this.resetThinking();
    this.positionAt(view, pos);
    el.style.display = "";
  }

  showActions(view: EditorView, pos: number): void {
    const el = this.ensureEl(view);
    this.spinnerEl!.style.display = "none";
    this.actionsEl!.style.display = "";
    this.positionAt(view, pos);
    el.style.display = "";
  }

  appendThinking(delta: string): void {
    if (!delta || !this.thinkingBodyEl || !this.thinkingWrapEl) return;
    this.thinkingWrapEl.style.display = "";
    this.thinkingBodyEl.textContent += delta;
    this.thinkingBodyEl.scrollTop = this.thinkingBodyEl.scrollHeight;
  }

  resetThinking(): void {
    if (this.thinkingBodyEl) this.thinkingBodyEl.textContent = "";
    if (this.thinkingWrapEl) this.thinkingWrapEl.style.display = "none";
  }

  hide(): void {
    if (this.el) {
      this.el.style.display = "none";
    }
  }

  destroy(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
      this.spinnerEl = null;
      this.actionsEl = null;
      this.thinkingWrapEl = null;
      this.thinkingBodyEl = null;
      this.toggleEl = null;
    }
  }

  private positionAt(view: EditorView, pos: number): void {
    if (!this.el) return;
    let coords = view.coordsAtPos(pos);
    if (!coords) return;
    const rect = document.body.getBoundingClientRect();
    const top = coords.bottom - rect.top;
    const left = coords.left - rect.left;
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }
}
