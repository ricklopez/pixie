"""Checkpoint controller: lets the engine choose actions inside a reviewed checkpoint, verifies each
checkpoint's observable postcondition, binds exact input values, and stops on any policy or limit breach.

Outcomes (the gateway maps them to run states):
  extracted      every checkpoint passed; extraction is attached for independent verification
  auth_required  an authRequiredSignal was observed on the live page
  blocked        the engine could not satisfy a checkpoint within its bounds, or reported BLOCKED/DONE early
  failed         model/browser/infrastructure error
  cancelled      cancellation requested by the gateway
"""

import re
import time
from datetime import datetime, timezone

from .conditions import all_hold, first_failing
from .extract import extract_outputs
from .lists import MutationRefused, apply_affordances, guard, read_fields, read_lists, verify, wait_settled
from .policy import PolicyRejection, check_action, check_origin

SECRET_PLACEHOLDER = "<the stored account credential>"


class Cancelled(Exception):
    pass


class Controller:
    def __init__(
        self,
        definition,
        inputs,
        session,
        engine,
        emit,
        *,
        secrets=None,
        deadline_ms=None,
        is_cancelled=lambda: False,
        evidence=None,
    ):
        self.definition = definition
        self.inputs = inputs
        self.secrets = secrets or {}
        self.session = session
        self.engine = engine
        self.emit = emit
        self.is_cancelled = is_cancelled
        self.evidence = evidence
        self.limits = definition.get("limits", {})
        self.max_actions = int(self.limits.get("maxActions", 60))
        self.deadline_ms = deadline_ms or int(self.limits.get("deadlineMs", 120_000))
        self.history = []
        self.model_calls = 0
        self.actions = 0
        self.mutations = []
        self.guarded = {}
        self.started = time.perf_counter()

    # -- helpers -------------------------------------------------------------------------------------------
    def elapsed_ms(self):
        return round((time.perf_counter() - self.started) * 1000)

    def check_budget(self):
        if self.is_cancelled():
            raise Cancelled()
        if self.elapsed_ms() > self.deadline_ms:
            raise TimeoutError(f"Run exceeded the {self.deadline_ms} ms deadline")

    def render(self, template, *, secrets_as=SECRET_PLACEHOLDER):
        """Substitute caller inputs into a reviewed template. Secrets are never rendered."""

        def sub(match):
            name = match.group(1)
            for field in self.definition["inputs"]:
                if field["name"] == name and field["source"]["kind"] == "accountSecret":
                    return secrets_as
            value = self.inputs.get(name)
            return str(value) if value is not None else match.group(0)

        return re.sub(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", sub, template)

    def goal_for(self, checkpoint):
        return self.render(checkpoint["objective"])

    def conditions_for(self, checkpoint, key):
        rendered = []
        for condition in checkpoint.get(key, []):
            c = dict(condition)
            for k in ("text", "label"):
                if isinstance(c.get(k), str):
                    c[k] = self.render(c[k])
            rendered.append(c)
        return rendered

    def value_for(self, field):
        source = field["source"]
        if source["kind"] == "accountSecret":
            ref = source["secretRef"]
            if ref not in self.secrets:
                raise RuntimeError(f"Account secret {ref!r} is not configured; refusing to continue")
            return self.secrets[ref]
        value = self.inputs.get(field["name"])
        if value is None:
            raise RuntimeError(f"Input {field['name']!r} has no value")
        return value if isinstance(value, str) else str(value).lower() if isinstance(value, bool) else str(value)

    def observe(self):
        if self.definition.get("lists"):
            try:
                wait_settled(self.session, self.definition)
            except Exception:  # noqa: BLE001 - a page mid-navigation has no DOM yet; observe() reports the real state
                pass
        if self.definition.get("affordances"):
            try:
                apply_affordances(self.session, self.definition)
            except Exception:  # noqa: BLE001 - a page mid-navigation has no DOM yet; observe() reports the real state
                pass
        page = self.session.observe(screenshot=False)
        check_origin(page["url"], self.definition["allowedOrigins"])
        page["lists"] = read_lists(self.session, self.definition) if self.definition.get("lists") else {}
        page["fields"] = read_fields(self.session)
        self.emit(
            {
                "type": "observation",
                "url": page["url"],
                "actionCount": len(page.get("actions", [])),
                "fingerprint": page.get("fingerprint"),
                "elapsedMs": self.elapsed_ms(),
            }
        )
        if any(all_hold([signal], page) for signal in self.definition.get("authRequiredSignals", [])):
            signal = next(s for s in self.definition["authRequiredSignals"] if all_hold([s], page))
            self.emit({"type": "auth_required", "signal": signal, "url": page["url"]})
            return page, "auth_required"
        return page, None

    def snapshot(self, checkpoint_id, label):
        if not self.evidence:
            return
        try:
            data = self.session.screenshot()
        except Exception:  # noqa: BLE001 - evidence capture must not change the outcome
            return
        if data:
            ref = self.evidence.store(f"{checkpoint_id}-{label}.jpg", data)
            self.emit({"type": "screenshot", "checkpointId": checkpoint_id, "label": label, "ref": ref})

    # -- main loop -----------------------------------------------------------------------------------------
    def run(self):
        extraction = {}
        try:
            for checkpoint in self.definition["checkpoints"]:
                outcome = self.run_checkpoint(checkpoint, extraction)
                if outcome is not None:
                    return outcome
            observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            page, _ = self.observe()
            self.emit(
                {
                    "type": "extraction",
                    "outputs": extraction,
                    "mutations": self.mutations,
                    "observedAt": observed_at,
                    "finalUrl": page["url"],
                }
            )
            return self.finish("extracted", None)
        except Cancelled:
            return self.finish("cancelled", "Cancellation requested")
        except PolicyRejection as error:
            return self.finish("failed", f"policy_violation:{error.code}: {error}")
        except TimeoutError as error:
            return self.finish("failed", f"deadline: {error}")
        except Exception as error:  # noqa: BLE001 - reported verbatim as an infrastructure/model failure
            return self.finish("failed", f"{type(error).__name__}: {str(error)[:300]}")

    def finish(self, outcome, reason):
        result = {
            "type": "finished",
            "outcome": outcome,
            "reason": reason,
            "elapsedMs": self.elapsed_ms(),
            "modelCalls": self.model_calls,
            "actions": self.actions,
        }
        self.emit(result)
        return result

    def run_checkpoint(self, checkpoint, extraction):
        cp_id = checkpoint["id"]
        self.emit({"type": "checkpoint", "id": cp_id, "status": "started"})
        self.check_budget()
        page, auth = self.observe()
        if auth:
            return self.finish("auth_required", f"Login required detected at checkpoint {cp_id!r}")
        precondition = self.conditions_for(checkpoint, "precondition")
        postcondition = self.conditions_for(checkpoint, "postcondition")
        failing = first_failing(precondition, page)
        if failing is not None:
            self.emit(
                {"type": "checkpoint", "id": cp_id, "status": "failed", "reason": f"precondition not met: {failing}"}
            )
            return self.finish("blocked", f"Checkpoint {cp_id!r} precondition not met: {failing}")
        mutation = checkpoint.get("mutation")
        before = target = value = None
        # A mutation may declare `guardAt`: an earlier checkpoint whose starting list is the pre-write snapshot
        # (e.g. an editor that changes the visible title while typing, before the save that commits it).
        for owner in self.definition["checkpoints"]:
            m = owner.get("mutation")
            if m and m.get("guardAt", owner["id"]) == cp_id:
                snap_before = list(page["lists"].get(m["list"], []))
                snap_target = self.render(m["target"], secrets_as="") if m.get("target") else None
                snap_value = self.render(m["value"], secrets_as="") if m.get("value") else None
                try:
                    guard(m, snap_before, snap_target, snap_value)
                except MutationRefused as error:
                    reason = f"write refused: {error}"
                    self.emit({"type": "checkpoint", "id": cp_id, "status": "failed", "reason": reason})
                    return self.finish("blocked", f"Write at checkpoint {cp_id!r} refused before any action: {error}")
                self.guarded[owner["id"]] = (snap_before, snap_target, snap_value)
        if mutation:
            if cp_id not in self.guarded:
                return self.finish("failed", f"Checkpoint {cp_id!r} mutation was never guarded")
            before, target, value = self.guarded[cp_id]
        self.snapshot(cp_id, "before")

        goal = self.goal_for(checkpoint)
        attempts = 0
        rejections = 0
        stale = 0
        while not all_hold(postcondition, page):
            self.check_budget()
            if attempts >= checkpoint["maxActions"] or self.actions >= self.max_actions:
                failing = first_failing(postcondition, page)
                self.emit(
                    {
                        "type": "checkpoint",
                        "id": cp_id,
                        "status": "failed",
                        "reason": f"action budget exhausted; unmet: {failing}",
                    }
                )
                return self.finish(
                    "blocked", f"Checkpoint {cp_id!r} action budget exhausted; unmet postcondition {failing}"
                )
            decision = self.engine.choose(page, goal, self.history)
            self.model_calls += 1
            attempts += 1
            self.emit(
                {
                    "type": "model_call",
                    "checkpointId": cp_id,
                    "model": decision.get("model"),
                    "latencyMs": decision.get("latency_ms"),
                    "operation": decision.get("operation"),
                    "target": decision.get("target"),
                    "choice": decision.get("choice"),
                    "confidence": decision.get("confidence"),
                    "targetConfidence": decision.get("target_confidence"),
                    "operationProbabilities": decision.get("operation_probabilities"),
                    "targetProbabilities": decision.get("target_probabilities"),
                    "usage": decision.get("usage"),
                    "elapsedMs": self.elapsed_ms(),
                }
            )
            choice = decision["choice"]
            if choice == "DONE":
                # DONE is a claim, not completion: only the observable postcondition can pass a checkpoint.
                page, auth = self.observe()
                if auth:
                    return self.finish("auth_required", f"Login required detected at checkpoint {cp_id!r}")
                if all_hold(postcondition, page):
                    break
                failing = first_failing(postcondition, page)
                self.emit(
                    {
                        "type": "checkpoint",
                        "id": cp_id,
                        "status": "failed",
                        "reason": f"engine reported DONE but postcondition unmet: {failing}",
                    }
                )
                return self.finish("blocked", f"Engine reported DONE at {cp_id!r} but postcondition unmet: {failing}")
            if choice == "BLOCKED":
                self.emit({"type": "checkpoint", "id": cp_id, "status": "failed", "reason": "engine reported BLOCKED"})
                return self.finish("blocked", f"Engine reported BLOCKED at checkpoint {cp_id!r}")
            action = next((a for a in page["actions"] if a["id"] == choice), None)
            if action is None:
                raise RuntimeError(f"Engine chose {choice!r}, which is not an observed action")
            try:
                field = check_action(checkpoint, self.definition, action)
            except PolicyRejection as error:
                rejections += 1
                self.emit(
                    {
                        "type": "policy_rejected",
                        "checkpointId": cp_id,
                        "code": error.code,
                        "reason": str(error),
                        "action": action.get("label"),
                        "kind": action.get("kind"),
                    }
                )
                self.history.append(
                    {"action": action.get("label"), "kind": "rejected", "text": None, "page_changed": False}
                )
                if rejections >= 2:
                    return self.finish("blocked", f"Engine repeatedly chose disallowed actions at {cp_id!r}: {error}")
                continue
            self.emit(
                {
                    "type": "policy_allowed",
                    "checkpointId": cp_id,
                    "action": action.get("label"),
                    "kind": action.get("kind"),
                    "boundInput": field["name"] if field is not None else None,
                }
            )
            text = self.value_for(field) if field is not None else None
            try:
                self.session.act(action, page, text=text)
            except ValueError as error:  # upstream StalePage: the page moved between decision and input
                if type(error).__name__ != "StalePage":
                    raise
                stale += 1
                if stale > 3:
                    raise
                self.emit({"type": "stale_page", "checkpointId": cp_id, "reason": str(error), "attempt": stale})
                page, auth = self.observe()
                continue
            self.actions += 1
            executed_ms = self.elapsed_ms()
            new_page, auth = self.observe()
            entry = {
                "step": self.actions,
                "action": action.get("label"),
                "kind": action.get("kind"),
                "choice": choice,
                "text": None if field is None or field["source"]["kind"] == "accountSecret" else text,
                "boundInput": field["name"] if field is not None else None,
                "page_changed": new_page.get("fingerprint") != page.get("fingerprint"),
                "url": new_page["url"],
                "executed_ms": executed_ms,
            }
            self.history.append(entry)
            self.emit(
                {
                    "type": "action",
                    "checkpointId": cp_id,
                    **{k: v for k, v in entry.items() if k != "text"},
                    "typedLength": len(text) if text else 0,
                }
            )
            if auth:
                return self.finish("auth_required", f"Login required detected after an action in checkpoint {cp_id!r}")
            page = new_page
        self.snapshot(cp_id, "after")
        if mutation:
            page, _ = self.observe()
            after = list(page["lists"].get(mutation["list"], []))
            ok, reason = verify(mutation, before, after, target, value)
            check = {
                "type": "mutation_check",
                "checkpointId": cp_id,
                "kind": mutation["kind"],
                "ok": ok,
                "reason": reason,
                "before": len(before),
                "after": len(after),
            }
            self.emit(check)
            self.mutations.append({k: v for k, v in check.items() if k != "type"})
            if not ok:
                self.emit(
                    {"type": "checkpoint", "id": cp_id, "status": "failed", "reason": f"write not confirmed: {reason}"}
                )
                return self.finish("blocked", f"Write at checkpoint {cp_id!r} not confirmed from the page: {reason}")
        extraction.update(extract_outputs(self.session, self.definition, cp_id, page.get("lists")))
        self.emit(
            {
                "type": "checkpoint",
                "id": cp_id,
                "status": "passed",
                "actions": self.actions,
                "elapsedMs": self.elapsed_ms(),
            }
        )
        return None
