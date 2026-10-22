/**
 * Runs inside the controlled page. Emits semantic descriptors of interacted elements through the
 * `__gatewayRecorderEvent` binding. Field values are never sent: only presence and length.
 */
export function pageScript(): void {
  type Emitter = (payload: unknown) => void;
  const w = window as unknown as { __gatewayRecorderEvent?: Emitter; __gatewayRecorderInstalled?: boolean };
  if (w.__gatewayRecorderInstalled) return;
  w.__gatewayRecorderInstalled = true;
  const emit: Emitter = (payload) => {
    try {
      w.__gatewayRecorderEvent?.(payload);
    } catch {
      /* binding missing during teardown */
    }
  };
  const isMainFrame = window.top === window;
  const clip = (v: string | null | undefined, n = 80) => (v ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);
  const labelFor = (el: Element): string | null => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (text.trim()) return clip(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clip(labels[0]?.textContent ?? "");
    const wrapping = el.closest("label");
    if (wrapping) return clip(wrapping.textContent?.replace((el as HTMLInputElement).value ?? "", "") ?? "");
    return null;
  };
  const describe = (node: EventTarget | null) => {
    const el = node instanceof Element ? (node.closest("button,a,input,select,textarea,[role]") ?? node) : null;
    if (!el) return undefined;
    const input = el as HTMLInputElement;
    const label = labelFor(el);
    const role = el.getAttribute("role") ?? null;
    const name = el.getAttribute("name");
    const id = el.id || null;
    const text = clip(el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? null : el.textContent);
    const hints: string[] = [];
    if (label) hints.push(`label=${label}`);
    if (role) hints.push(`role=${role}`);
    if (name) hints.push(`name=${name}`);
    if (id) hints.push(`id=${id}`);
    if (text && (el.tagName === "BUTTON" || el.tagName === "A")) hints.push(`text=${text}`);
    return {
      tag: el.tagName,
      role,
      label,
      name,
      id,
      placeholder: input.placeholder || null,
      inputType: el.tagName === "INPUT" ? input.type || "text" : null,
      text,
      selectorHints: hints
    };
  };
  const common = () => ({ url: location.href, isMainFrame });

  document.addEventListener(
    "click",
    (e) => {
      const target = describe(e.target);
      if (target && (target.tag === "INPUT" || target.tag === "TEXTAREA" || target.tag === "SELECT")) return; // focus, not an action
      emit({ kind: "click", target, ...common() });
    },
    true
  );
  document.addEventListener(
    "change",
    (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement | null;
      if (!el) return;
      const target = describe(el);
      if (el.tagName === "SELECT") {
        const select = el as HTMLSelectElement;
        emit({ kind: "select", target, hasValue: true, valueLength: select.value.length, optionLabel: select.selectedOptions[0]?.label ?? null, ...common() });
        return;
      }
      if ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio") {
        emit({ kind: "click", target, ...common() });
        return;
      }
      emit({ kind: "input", target, hasValue: el.value.length > 0, valueLength: el.value.length, ...common() });
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") emit({ kind: "keypress", key: e.key, target: describe(e.target), ...common() });
    },
    true
  );
  document.addEventListener("submit", (e) => emit({ kind: "submit", target: describe(e.target), ...common() }), true);
  for (const kind of ["dragstart", "contextmenu", "paste"]) {
    document.addEventListener(kind, (e) => emit({ kind, target: describe(e.target), reason: `'${kind}' cannot be replayed by the engine.`, ...common() }), true);
  }
}

/** Serialized page script. Some TS loaders (tsx/esbuild keepNames) emit a `__name` helper, so a shim is included. */
export function pageScriptSource(): string {
  return `(() => { const __name = (fn) => fn; (${pageScript.toString()})(); })();`;
}
