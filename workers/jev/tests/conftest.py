import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]

# Fixture pages emulate the synthetic portal's observable state as jev-ultrafast would report it.
PORTAL = "http://127.0.0.1:4174"


def page(url, text, actions):
    return {"url": url, "title": "Synthetic", "text": text, "actions": actions, "fingerprint": url + str(len(text))}


SEARCH = page(
    f"{PORTAL}/demo-portal",
    "Synthetic demo data only. Member search Member ID Search",
    [
        {"id": "e1", "kind": "fill", "label": "Member ID", "node": 1, "role": "textbox", "value": ""},
        {"id": "e2", "kind": "click", "label": "Open Member ID", "node": 1, "role": "textbox", "value": ""},
        {"id": "e3", "kind": "click", "label": "Search", "node": 2, "role": "button"},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ],
)


def result_page(member_id, status="Active"):
    return page(
        f"{PORTAL}/demo-portal/members?memberId={member_id}",
        f"Member result Member ID {member_id} Eligibility status {status} Plan Synthetic PPO Basic "
        "View benefits overview",
        [
            {"id": "e1", "kind": "click", "label": "View benefits overview", "node": 5, "role": "link"},
            {"id": "e2", "kind": "click", "label": "New search", "node": 6, "role": "link"},
            {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
        ],
    )


def benefits_page(member_id):
    return page(
        f"{PORTAL}/demo-portal/members/{member_id}/benefits",
        f"Benefits overview Member ID {member_id} Eligibility status Active Benefits Annual maximum Deductible",
        [{"id": "wait", "kind": "wait", "label": "Wait for the page to update"}],
    )


LOGIN = page(
    f"{PORTAL}/demo-portal/login?next=%2Fdemo-portal",
    "Sign in Your portal session has expired. Sign in to continue. Username",
    [{"id": "e1", "kind": "fill", "label": "Username", "node": 1, "role": "textbox", "value": ""}],
)


class FakeSession:
    """Deterministic page model: typing records the value, clicking Search shows the member the portal returns."""

    def __init__(self, directory, values=None, login_after_search=False):
        self.directory = directory  # memberId typed -> memberId displayed
        self.values = values or {}
        self.login_after_search = login_after_search
        self.current = SEARCH
        self.typed = None
        self.acted = []
        self.closed = False

    def observe(self, screenshot=False):
        return self.current

    def act(self, action, page, text=None):
        self.acted.append((action["label"], text))
        if action["kind"] == "fill":
            self.typed = text
        elif action["label"] == "Search":
            if self.login_after_search:
                self.current = LOGIN
            elif self.typed in self.directory:
                self.current = result_page(self.directory[self.typed])
            else:
                self.current = SEARCH
        elif action["label"] == "View benefits overview":
            self.current = benefits_page(self.directory[self.typed])

    def evaluate(self, expression):
        for name, value in self.values.items():
            if json.dumps(name) in expression:
                return value
        return None

    def screenshot(self):
        return b"jpeg"

    def close(self):
        self.closed = True


@pytest.fixture
def definition():
    """The reference definition, exported by the TypeScript package into a fixture at test time."""
    fixture = Path(__file__).with_name("eligibility-overview.json")
    return json.loads(fixture.read_text())
