from gateway_worker.lists import READ_LIST_JS, read_lists


class FakeListSession:
    def __init__(self, items):
        self.items = items
        self.expression = None

    def evaluate(self, expression):
        self.expression = expression
        return self.items


def test_read_lists_preserves_reviewed_fields_and_requests_field_extraction():
    spec = {
        "item": "tr.athing",
        "text": ".titleline > a",
        "fields": {
            "id": {"attribute": "id"},
            "rank": {"selector": ".rank"},
            "url": {"selector": ".titleline > a", "attribute": "href"},
        },
    }
    items = [
        {
            "text": "First story",
            "completed": False,
            "fields": {"id": "story-123", "rank": "1.", "url": "https://example.test/story-123"},
        }
    ]
    session = FakeListSession(items)

    assert read_lists(session, {"lists": {"stories": spec}}) == {"stories": items}
    assert READ_LIST_JS in session.expression
    assert '"fields"' in session.expression


def test_read_lists_keeps_legacy_items_unchanged_when_fields_are_absent():
    items = [{"text": "First story", "completed": False}]
    session = FakeListSession(items)

    legacy_spec = {"lists": {"stories": {"item": "tr.athing", "text": ".titleline > a"}}}
    assert read_lists(session, legacy_spec) == {"stories": items}
