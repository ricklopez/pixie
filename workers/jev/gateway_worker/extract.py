"""Deterministic DOM extraction for reviewed output bindings.

Extraction reads the actual document through CDP using generic label/table lookups. It never asks a model
what the value is, and it returns null (not a default) when the binding does not resolve.
"""

import json

# Generic label → value lookup: <dt>/<dd>, <th>/<td>, <label>/control, or an element followed by a sibling.
LABEL_VALUE_JS = """((label) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(label);
  const textOf = (e) => (e ? (e.innerText ?? e.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  for (const dt of document.querySelectorAll('dt')) {
    if (norm(textOf(dt)) === wanted) {
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName !== 'DD') dd = dd.nextElementSibling;
      return dd ? textOf(dd) : null;
    }
  }
  for (const th of document.querySelectorAll('th[scope="row"], tr > th:first-child')) {
    if (norm(textOf(th)) === wanted) {
      const td = th.parentElement && th.parentElement.querySelector('td');
      return td ? textOf(td) : null;
    }
  }
  for (const lab of document.querySelectorAll('label')) {
    if (norm(textOf(lab)) === wanted && lab.control) return String(lab.control.value ?? '');
  }
  for (const e of document.querySelectorAll('span,strong,b,div,p,li')) {
    if (norm(textOf(e)).replace(/:$/, '') === wanted && e.nextElementSibling && !e.children.length) {
      return textOf(e.nextElementSibling);
    }
  }
  return null;
})"""

TABLE_CELL_JS = """((spec) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const textOf = (e) => (e ? (e.innerText ?? e.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  const tables = [...document.querySelectorAll('table')].filter((t) => {
    const prev = t.previousElementSibling;
    const name = t.getAttribute('aria-label') || (t.caption ? textOf(t.caption) : '') ||
      (prev && /^H[1-6]$/.test(prev.tagName) ? textOf(prev) : '');
    return norm(name) === norm(spec.table);
  });
  if (!tables.length) return null;
  for (const table of tables) {
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    if (!headerRow) continue;
    const headers = [...headerRow.children].map((h) => norm(textOf(h)));
    const col = headers.indexOf(norm(spec.column));
    const whereCol = spec.where ? headers.indexOf(norm(spec.where.column)) : -1;
    if (col < 0 || (spec.where && whereCol < 0)) continue;
    const rows = [...table.querySelectorAll('tbody tr, tr')].filter((r) => r !== headerRow);
    for (const row of rows) {
      const cells = [...row.children];
      if (!cells.length || norm(textOf(cells[0])) !== norm(spec.rowLabel)) continue;
      if (spec.where && norm(textOf(cells[whereCol])) !== norm(spec.where.equals)) continue;
      return cells[col] ? textOf(cells[col]) : null;
    }
  }
  return null;
})"""


def describe(extractor):
    if extractor["kind"] == "listItems":
        return f"list '{extractor['list']}'"
    if extractor["kind"] == "labelValue":
        return f"label '{extractor['label']}'"
    if extractor["kind"] == "tableCell":
        where = (
            f" where {extractor['where']['column']}={extractor['where']['equals']}" if extractor.get("where") else ""
        )
        return f"table '{extractor['table']}' row '{extractor['rowLabel']}' column '{extractor['column']}'{where}"
    return extractor["kind"]


def expression(extractor):
    if extractor["kind"] == "labelValue":
        return f"{LABEL_VALUE_JS}({json.dumps(extractor['label'])})"
    if extractor["kind"] == "tableCell":
        spec = {k: extractor[k] for k in ("table", "rowLabel", "column")}
        if extractor.get("where"):
            spec["where"] = extractor["where"]
        return f"{TABLE_CELL_JS}({json.dumps(spec)})"
    raise ValueError(f"No DOM expression for extractor {extractor['kind']!r}")


def extract_outputs(session, definition, checkpoint_id, lists=None):
    """Resolve every output bound to this checkpoint. Missing values are reported as null."""
    results = {}
    for output in definition["outputs"]:
        extractor = output["extractor"]
        if extractor["kind"] == "observedAt" or extractor.get("checkpointId") != checkpoint_id:
            continue
        if extractor["kind"] == "listItems":
            value = (lists or {}).get(extractor["list"])
            results[output["name"]] = {"value": value, "source": describe(extractor), "checkpointId": checkpoint_id}
            continue
        try:
            value = session.evaluate(expression(extractor))
        except Exception as error:  # noqa: BLE001 - an extraction error is reported, never guessed
            value = None
            results[output["name"]] = {
                "value": None,
                "source": describe(extractor),
                "checkpointId": checkpoint_id,
                "error": str(error)[:200],
            }
            continue
        if value is not None and not isinstance(value, str):
            value = str(value)
        results[output["name"]] = {"value": value, "source": describe(extractor), "checkpointId": checkpoint_id}
    return results
