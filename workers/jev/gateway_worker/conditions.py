"""Observable conditions evaluated against an observed page. No model involvement."""

import re


def _norm(text):
    return re.sub(r"\s+", " ", (text or "")).strip().casefold()


def field_labels(page):
    return [_norm(a.get("label", "")) for a in page.get("actions", []) if a.get("kind") == "fill"]


def _items(page, name):
    return (page.get("lists") or {}).get(name, [])


def holds(condition, page):
    kind = condition["kind"]
    if kind == "itemPresent":
        wanted = _norm(condition["text"])
        return any(_norm(i.get("text")) == wanted for i in _items(page, condition["list"]))
    if kind == "itemAbsent":
        wanted = _norm(condition["text"])
        return not any(_norm(i.get("text")) == wanted for i in _items(page, condition["list"]))
    if kind == "urlMatches":
        return re.search(condition["pattern"], page.get("url", "")) is not None
    if kind == "textPresent":
        return _norm(condition["text"]) in _norm(page.get("text", ""))
    if kind == "labelPresent":
        return _norm(condition["label"]) in _norm(page.get("text", ""))
    if kind == "fieldValue":
        wanted = _norm(condition["label"])
        expected = _norm(condition["text"])
        return any(
            wanted in _norm(label) and _norm(value) == expected for label, value in (page.get("fields") or {}).items()
        )
    if kind == "fieldVisible":
        wanted = _norm(condition["label"])
        return any(wanted in label for label in field_labels(page))
    raise ValueError(f"Unknown condition kind {kind!r}")


def all_hold(conditions, page):
    return all(holds(c, page) for c in conditions)


def first_failing(conditions, page):
    for c in conditions:
        if not holds(c, page):
            return c
    return None
