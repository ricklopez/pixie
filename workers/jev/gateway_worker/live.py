"""Live adapters: upstream jev-ultrafast Browser (CDP through browser-harness) and TypeSafe choose().

The gateway supplies the controlled browser through BU_CDP_URL; the worker owns exactly one tab and closes
it on exit. Upstream opens its tab as a background target, so the visible window of the dedicated Chrome shows
the profile's foreground tab while the run's screenshots are recorded as evidence.
TYPESAFE_API_KEY is read by upstream from the environment and never logged.
"""

import base64
import os


def require_configuration():
    missing = [name for name in ("TYPESAFE_API_KEY", "BU_CDP_URL") if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"Missing required configuration: {', '.join(missing)}")


class LiveSession:
    def __init__(self, start_url):
        from jev_ultrafast.browser import Browser

        self.browser = Browser(start_url)

    def observe(self, screenshot=False):
        return self.browser.observe(screenshot=screenshot)

    def act(self, action, page, text=None):
        return self.browser.act(action, page, text=text)

    def evaluate(self, expression):
        return self.browser.evaluate(expression)

    def screenshot(self):
        data = self.browser.call("Page.captureScreenshot", format="jpeg", quality=60)["data"]
        return base64.b64decode(data)

    def close(self):
        self.browser.close()
        # Each run uses its own named browser-harness daemon (BU_NAME); stop it so its process and
        # background tab do not accumulate in the persistent profile.
        try:
            from browser_harness.admin import restart_daemon

            restart_daemon()
        except Exception:  # noqa: BLE001 - best-effort cleanup after the run already finished
            pass


class LiveEngine:
    def __init__(self):
        from jev_ultrafast import model

        self.model = model

    @property
    def provider_client(self):
        return self.model.CLIENT

    def choose(self, page, goal, history):
        decision = self.model.choose(page, goal, history)
        # The request body echoes page text and the goal; keep it out of the event stream.
        decision.pop("request", None)
        return decision
