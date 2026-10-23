import os
from contextlib import contextmanager
from urllib.parse import urlsplit


class ProviderCallBudgetExceeded(RuntimeError):
    reason = "provider_call_budget_exhausted"


class ProviderCallBudget:
    def __init__(self, max_calls=None):
        raw = os.environ.get("PIXIE_MAX_PROVIDER_CALLS", "40") if max_calls is None else max_calls
        try:
            self.max_calls = int(raw)
        except (TypeError, ValueError) as error:
            raise ValueError("PIXIE_MAX_PROVIDER_CALLS must be a non-negative integer") from error
        if self.max_calls < 0:
            raise ValueError("PIXIE_MAX_PROVIDER_CALLS must be a non-negative integer")
        self.calls = 0
        self.on_call = None

    def record_request(self, url):
        if self.calls >= self.max_calls:
            raise ProviderCallBudgetExceeded(ProviderCallBudgetExceeded.reason)
        host = urlsplit(str(url)).hostname
        provider = "typesafe" if host == "api.typesafe.ai" else "text-model"
        self.calls += 1
        if self.on_call:
            self.on_call(provider)

    @contextmanager
    def instrument(self, client):
        if client is None:
            yield
            return
        original_post = client.post

        def budgeted_post(url, *args, **kwargs):
            self.record_request(url)
            return original_post(url, *args, **kwargs)

        client.post = budgeted_post
        try:
            yield
        finally:
            client.post = original_post
