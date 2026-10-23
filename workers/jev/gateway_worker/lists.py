"""Reviewed list reading, the accessibility shim for unlabeled site controls, and mutation verification.

Everything here reads the rendered DOM through CDP. Nothing reads or writes site storage, and the shim only
adds roles/labels (plus a click->dblclick forward) so the engine can *see* controls it then has to choose.
"""

import json
import re
import time

READ_LIST_JS = """((spec) => {
  const textOf = (e) => (e ? (e.innerText ?? e.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  const fieldTextOf = (e) => (e ? String(e.textContent ?? '').trim() : null);
  const out = [];
  for (const item of document.querySelectorAll(spec.item)) {
    if (!item.checkVisibility || !item.checkVisibility({checkVisibilityCSS:true})) continue;
    const t = item.querySelector(spec.text);
    if (!t) continue;
    const value = {text: textOf(t), completed: spec.completed ? !!item.querySelector(spec.completed) : false};
    if (spec.fields !== undefined) {
      value.fields = {};
      for (const [name, field] of Object.entries(spec.fields)) {
        const target = field.selector ? item.querySelector(field.selector) : item;
        const fieldValue = !target ? null :
          field.attribute === undefined ? fieldTextOf(target) : target.getAttribute(field.attribute);
        value.fields[name] = fieldValue;
      }
    }
    out.push(value);
  }
  return out;
})"""

APPLY_AFFORDANCES_JS = """((affordances) => {
  const textOf = (e) => (e ? (e.innerText ?? e.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  let applied = 0;
  for (const a of affordances) {
    for (const e of document.querySelectorAll(a.selector)) {
      const scope = a.item ? e.closest(a.item) : null;
      const itemText = scope ? textOf(a.itemText ? scope.querySelector(a.itemText) : scope) : '';
      const label = a.label.replace(/\\{\\{\\s*text\\s*\\}\\}/g, itemText);
      if (e.getAttribute('aria-label') !== label) { e.setAttribute('aria-label', label); applied++; }
      if (a.role === 'button' && e.tagName !== 'BUTTON' && e.tagName !== 'INPUT') e.setAttribute('role', 'button');
      if (a.activate === 'dblclick' && !e.dataset.pixieDblclick) {
        e.dataset.pixieDblclick = '1';
        const forward = () => e.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
        e.addEventListener('click', forward);
      }
    }
  }
  return applied;
})"""


SETTLED_JS = """((specs) => specs.every((spec) => [...document.querySelectorAll(spec.item)].every((item) =>
  !item.checkVisibility || !item.checkVisibility({checkVisibilityCSS:true}) ||
  item.checkVisibility({checkOpacity:true}))))"""


def wait_settled(session, definition, timeout=2.0, interval=0.1):
    """Wait until rendered rows are fully visible (enter/leave transitions done) and their count and geometry
    are stable across two polls, so neither the engine's observer nor our snapshot sees a half-animated list."""
    specs = list((definition.get("lists") or {}).values())
    if not specs:
        return
    deadline = time.monotonic() + timeout
    previous = None
    while True:
        counts = [
            session.evaluate(
                f"[...document.querySelectorAll({json.dumps(s['item'])})]"
                ".map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.y), Math.round(r.height)]; })"
            )
            for s in specs
        ]
        settled = session.evaluate(f"{SETTLED_JS}({json.dumps(specs)})")
        if settled and counts == previous:
            return
        previous = counts
        if time.monotonic() >= deadline:
            return
        time.sleep(interval)


READ_FIELDS_JS = """(() => {
  const out = {};
  for (const el of document.querySelectorAll('input, textarea')) {
    if (!el.checkVisibility || !el.checkVisibility({checkVisibilityCSS:true})) continue;
    const label = (el.getAttribute('aria-label') || el.placeholder || '').replace(/\\s+/g, ' ').trim();
    if (label) out[label] = String(el.value ?? '');
  }
  return out;
})"""


def read_fields(session):
    """Current values of visible labelled text inputs (evidence-only; values never leave the worker)."""
    fields = session.evaluate(f"{READ_FIELDS_JS}()")
    return fields if isinstance(fields, dict) else {}


def read_lists(session, definition):
    result = {}
    for name, spec in (definition.get("lists") or {}).items():
        items = session.evaluate(f"{READ_LIST_JS}({json.dumps(spec)})")
        result[name] = items if isinstance(items, list) else []
    return result


def apply_affordances(session, definition):
    affordances = definition.get("affordances") or []
    if not affordances:
        return 0
    return session.evaluate(f"{APPLY_AFFORDANCES_JS}({json.dumps(affordances)})")


def _norm(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def matches(items, text):
    wanted = _norm(text)
    return [i for i in items if _norm(i.get("text")) == wanted]


class MutationRefused(Exception):
    """The declared write cannot be performed safely; raised before any action is taken."""


def guard(mutation, items, target, value):
    """Refuse ambiguous or out-of-scope writes before the engine acts."""
    prefix = mutation.get("requirePrefix")
    kind = mutation["kind"]
    if kind in {"update", "delete"}:
        if target is None or not _norm(target):
            raise MutationRefused("target title is empty")
        if prefix and not target.startswith(prefix):
            raise MutationRefused(f"target {target!r} is outside the demo scope prefix {prefix!r}")
        found = matches(items, target)
        if not found:
            raise MutationRefused(f"no task titled {target!r} exists")
        if len(found) > 1:
            raise MutationRefused(f"{len(found)} tasks are titled {target!r}; identity is ambiguous")
    if kind in {"create", "update"}:
        if value is None or not _norm(value):
            raise MutationRefused("new title is empty")
        if prefix and not value.startswith(prefix):
            raise MutationRefused(f"new title {value!r} is outside the demo scope prefix {prefix!r}")
        if matches(items, value):
            raise MutationRefused(f"a task titled {value!r} already exists; titles must be unique")


def verify(mutation, before, after, target, value):
    """Compare the list before and after the checkpoint. Returns (ok, reason)."""
    kind = mutation["kind"]
    key = lambda i: (_norm(i.get("text")), bool(i.get("completed")))  # noqa: E731
    before_keys = sorted(key(i) for i in before)
    after_keys = sorted(key(i) for i in after)
    if kind == "create":
        expected = sorted(before_keys + [(_norm(value), False)])
        if after_keys != expected:
            return False, f"expected exactly one new task {value!r} with siblings unchanged; got {len(after)} items"
    elif kind == "delete":
        expected = sorted(k for k in before_keys if k[0] != _norm(target))
        if after_keys != expected:
            return False, f"expected only {target!r} removed with siblings unchanged; got {len(after)} items"
    elif kind == "update":
        old = next(k for k in before_keys if k[0] == _norm(target))
        expected = sorted([k for k in before_keys if k[0] != _norm(target)] + [(_norm(value), old[1])])
        if after_keys != expected:
            return False, f"expected {target!r} renamed to {value!r} with siblings unchanged; got {len(after)} items"
    return True, None
