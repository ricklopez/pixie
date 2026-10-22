"""Offline engine substitute for tests. It is not a model: it follows an explicit script of labelled
choices so the controller, policy and extraction can be exercised without paid model calls.
"""

import re


def _norm(text):
    return re.sub(r"\s+", " ", (text or "")).strip().casefold()


class ScriptedEngine:
    """script: list of steps; each step is {"operation": "TYPE_TEXT"|"CLICK"|"DONE"|"BLOCKED", "label": str}."""

    def __init__(self, script, model="scripted-offline"):
        self.script = list(script)
        self.model = model
        self.calls = 0

    def choose(self, page, goal, history):
        self.calls += 1
        if not self.script:
            step = {"operation": "BLOCKED"}
        else:
            step = self.script.pop(0)
        operation = step["operation"]
        if operation in {"DONE", "BLOCKED"}:
            return self._decision(operation, operation, None, {operation: 1.0})
        kind = {"TYPE_TEXT": "fill", "CLICK": "click", "SELECT": "select"}[operation]
        wanted = _norm(step["label"])
        for action in page["actions"]:
            if action.get("kind") == kind and wanted in _norm(action.get("label")):
                return self._decision(action["id"], operation, action["id"], {action["id"]: 1.0})
        return self._decision("BLOCKED", "BLOCKED", None, {"BLOCKED": 1.0})

    def _decision(self, choice, operation, target, probabilities):
        return {
            "choice": choice,
            "operation": operation,
            "target": target,
            "confidence": 1.0,
            "probabilities": probabilities,
            "operation_probabilities": {operation: 1.0},
            "target_probabilities": probabilities if target else {},
            "target_confidence": 1.0 if target else None,
            "model": self.model,
            "usage": {},
            "latency_ms": 0,
        }


class FailingEngine:
    """Simulates an unavailable model provider (upstream raises RuntimeError on HTTP/connection errors)."""

    def choose(self, page, goal, history):
        raise RuntimeError("Model provider returned HTTP 503; no action executed.")
