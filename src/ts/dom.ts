/* Small typed DOM helpers. Everything renders through textContent / setAttribute
 * so server-provided strings can never be interpreted as markup. */

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function maybeById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function qs<T extends Element>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`missing element ${selector}`);
  return node as T;
}

export function qsa<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export interface CreateOptions {
  class?: string;
  text?: string;
  id?: string;
  attrs?: Record<string, string>;
  children?: Node[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: CreateOptions = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) node.setAttribute(key, value);
  }
  if (opts.children) for (const child of opts.children) node.appendChild(child);
  return node;
}

/** Attach a listener and return a disposer. */
export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void
): () => void {
  target.addEventListener(type, handler as EventListener);
  return () => target.removeEventListener(type, handler as EventListener);
}

export function onDelegate<K extends keyof HTMLElementEventMap>(
  root: EventTarget,
  type: K,
  selector: string,
  handler: (ev: HTMLElementEventMap[K], matched: HTMLElement) => void
): void {
  root.addEventListener(type, ((ev: Event) => {
    const target = ev.target as HTMLElement | null;
    const matched = target?.closest<HTMLElement>(selector);
    if (matched) handler(ev as HTMLElementEventMap[K], matched);
  }) as EventListener);
}

export function clear(node: Element): void {
  node.textContent = "";
}

export function setText(node: Element, value: string): void {
  node.textContent = value;
}

export function show(node: HTMLElement, visible = true): void {
  node.classList.toggle("hidden", !visible);
}

/** Open/close a native <dialog>, falling back to a class toggle if unsupported. */
export function openDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}
