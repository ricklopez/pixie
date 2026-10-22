import json

from gateway_worker.budget import ProviderCallBudget
from gateway_worker.controller import Controller
from gateway_worker.scripted import FailingEngine, ScriptedEngine

from .conftest import FakeSession

HAPPY = [
    {"operation": "TYPE_TEXT", "label": "Member ID"},
    {"operation": "CLICK", "label": "Search"},
    {"operation": "CLICK", "label": "View benefits overview"},
    {"operation": "DONE"},
]


def run(definition, member, session, engine, **kw):
    events = []
    controller = Controller(definition, {"memberId": member}, session, engine, events.append, **kw)
    result = controller.run()
    return result, events


def test_happy_path_binds_exact_input_and_extracts(definition):
    session = FakeSession({"DEMO-1002": "DEMO-1002"}, values={"Member ID": "DEMO-1002", "Eligibility status": "Active"})
    result, events = run(definition, "DEMO-1002", session, ScriptedEngine(HAPPY))
    assert result["outcome"] == "extracted", result
    assert session.acted[0] == ("Member ID", "DEMO-1002")  # exact caller value, not model text
    kinds = [e["type"] for e in events]
    assert (
        kinds.count("model_call") == 3 and "extraction" in kinds
    )  # postconditions end checkpoints; DONE is never needed
    extraction = next(e for e in events if e["type"] == "extraction")
    assert extraction["outputs"]["memberId"]["value"] == "DEMO-1002"
    assert extraction["outputs"]["deductible"]["value"] is None  # unresolved bindings are null, never defaults
    actions = [e for e in events if e["type"] == "action"]
    assert all("text" not in e for e in actions) and actions[0]["typedLength"] == 9
    passed = [e for e in events if e["type"] == "checkpoint" and e["status"] == "passed"]
    assert [e["id"] for e in passed] == ["search-form", "member-result", "benefits-overview"]


def test_wrong_member_is_still_extracted_for_independent_verification(definition):
    session = FakeSession({"DEMO-2001": "DEMO-2002"}, values={"Member ID": "DEMO-2002"})
    result, events = run(definition, "DEMO-2001", session, ScriptedEngine(HAPPY))
    assert result["outcome"] == "extracted"
    extraction = next(e for e in events if e["type"] == "extraction")
    assert extraction["outputs"]["memberId"]["value"] == "DEMO-2002"


def test_done_without_postcondition_is_blocked(definition):
    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    result, events = run(definition, "DEMO-1001", session, ScriptedEngine([{"operation": "DONE"}]))
    assert result["outcome"] == "blocked"
    assert "DONE" in result["reason"] and "search-form" in result["reason"]


def test_unbound_text_field_is_rejected_by_policy(definition):
    stripped = json.loads(json.dumps(definition))
    stripped["inputs"][0]["binding"]["targetLabel"] = "Something else"
    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    script = [{"operation": "TYPE_TEXT", "label": "Member ID"}, {"operation": "TYPE_TEXT", "label": "Member ID"}]
    result, events = run(stripped, "DEMO-1001", session, ScriptedEngine(script))
    assert result["outcome"] == "blocked"
    rejected = [e for e in events if e["type"] == "policy_rejected"]
    assert len(rejected) == 2 and rejected[0]["code"] == "unbound-field"
    assert session.acted == []


def test_disallowed_effect_is_rejected(definition):
    narrowed = json.loads(json.dumps(definition))
    narrowed["checkpoints"][0]["allowedEffects"] = ["type"]
    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    script = [
        {"operation": "TYPE_TEXT", "label": "Member ID"},
        {"operation": "CLICK", "label": "Search"},
        {"operation": "CLICK", "label": "Search"},
    ]
    result, events = run(narrowed, "DEMO-1001", session, ScriptedEngine(script))
    assert result["outcome"] == "blocked"
    assert any(e["type"] == "policy_rejected" and e["code"] == "effect" for e in events)
    assert session.acted == [("Member ID", "DEMO-1001")]


def test_model_failure_is_explicit(definition):
    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    result, events = run(definition, "DEMO-1001", session, FailingEngine())
    assert result["outcome"] == "failed"
    assert "HTTP 503" in result["reason"]
    assert not any(e["type"] == "extraction" for e in events)


def test_expired_login_is_detected_as_auth_required(definition):
    session = FakeSession({"DEMO-1001": "DEMO-1001"}, login_after_search=True)
    result, events = run(definition, "DEMO-1001", session, ScriptedEngine(HAPPY))
    assert result["outcome"] == "auth_required"
    assert any(e["type"] == "auth_required" for e in events)


def test_action_budget_and_cancellation(definition):
    tight = json.loads(json.dumps(definition))
    tight["checkpoints"][0]["maxActions"] = 1
    session = FakeSession({})
    result, _ = run(tight, "DEMO-1001", session, ScriptedEngine([{"operation": "CLICK", "label": "Search"}] * 3))
    assert result["outcome"] == "blocked" and "budget" in result["reason"]

    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    result, _ = run(definition, "DEMO-1001", session, ScriptedEngine(HAPPY), is_cancelled=lambda: True)
    assert result["outcome"] == "cancelled"


def test_origin_escape_fails_the_run(definition):
    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    session.current = dict(session.current, url="https://evil.example/phish")
    result, _ = run(definition, "DEMO-1001", session, ScriptedEngine(HAPPY))
    assert result["outcome"] == "failed" and "policy_violation:origin" in result["reason"]


def test_provider_budget_stops_an_engine_that_keeps_requesting_calls(definition):
    budget = ProviderCallBudget(2)
    events = []

    class RunawayEngine:
        def choose(self, page, goal, history):
            while True:
                budget.record_request("https://api.typesafe.ai/v1/systemone")

    session = FakeSession({"DEMO-1001": "DEMO-1001"})
    controller = Controller(
        definition,
        {"memberId": "DEMO-1001"},
        session,
        RunawayEngine(),
        events.append,
        provider_budget=budget,
    )
    result = controller.run()

    assert result["outcome"] == "failed"
    assert result["reason"] == "provider_call_budget_exhausted"
    assert result["providerCalls"] == 2
    assert [event["type"] for event in events].count("provider_call") == 2


def test_provider_budget_defaults_to_forty(monkeypatch):
    monkeypatch.delenv("PIXIE_MAX_PROVIDER_CALLS", raising=False)
    assert ProviderCallBudget().max_calls == 40
