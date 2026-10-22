"""NDJSON worker entrypoint.

stdin  : one `run` command line, then optional `cancel` lines.
stdout : event lines (`started`, `checkpoint`, `model_call`, `action`, `policy_rejected`, `screenshot`,
         `auth_required`, `extraction`, `finished`).
The owned browser tab is closed on every exit path, including SIGTERM.
"""

import json
import os
import signal
import sys
import threading
from pathlib import Path

from .budget import ProviderCallBudget
from .controller import Controller
from .live import LiveEngine, LiveSession, require_configuration
from .scripted import FailingEngine, ScriptedEngine


class EvidenceStore:
    """Writes evidence files under an opaque directory chosen by the gateway (never inside the repo)."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def store(self, name, data):
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
        (self.directory / safe).write_bytes(data)
        return safe


def emit_to(stream):
    lock = threading.Lock()

    def emit(event):
        with lock:
            stream.write(json.dumps(event, separators=(",", ":")) + "\n")
            stream.flush()

    return emit


def build_engine(command):
    engine = command.get("engine", "live")
    if engine == "live":
        require_configuration()
        return LiveEngine()
    if engine == "scripted":
        return ScriptedEngine(command.get("script", []))
    if engine == "failing":
        return FailingEngine()
    raise RuntimeError(f"Unknown engine {engine!r}")


def run_command(command, emit, cancel_event):
    definition = command["definition"]
    session = None
    try:
        provider_budget = ProviderCallBudget()
        engine = build_engine(command)
        if not os.environ.get("BU_CDP_URL"):
            raise RuntimeError("Missing required configuration: BU_CDP_URL")
        session = LiveSession(definition["startUrl"])
        emit({"type": "started", "runId": command.get("runId"), "engine": command.get("engine", "live")})
        evidence = EvidenceStore(command["evidenceDir"]) if command.get("evidenceDir") else None
        controller = Controller(
            definition,
            command.get("input", {}),
            session,
            engine,
            emit,
            secrets=command.get("secrets") or {},
            deadline_ms=command.get("deadlineMs"),
            is_cancelled=cancel_event.is_set,
            evidence=evidence,
            provider_budget=provider_budget,
        )
        with provider_budget.instrument(getattr(engine, "provider_client", None)):
            return controller.run()
    except Exception as error:  # noqa: BLE001 - setup failures are reported explicitly, never masked
        result = {
            "type": "finished",
            "outcome": "failed",
            "reason": f"setup: {type(error).__name__}: {str(error)[:300]}",
            "elapsedMs": 0,
            "modelCalls": 0,
            "providerCalls": 0,
            "actions": 0,
        }
        emit(result)
        return result
    finally:
        if session is not None:
            try:
                session.close()
                emit({"type": "cleanup", "closedTab": True})
            except Exception as error:  # noqa: BLE001
                emit({"type": "cleanup", "closedTab": False, "error": str(error)[:200]})


def main(argv=None):
    emit = emit_to(sys.stdout)
    first = sys.stdin.readline()
    if not first:
        emit({"type": "finished", "outcome": "failed", "reason": "setup: no run command received"})
        return 2
    command = json.loads(first)
    if command.get("type") != "run":
        emit({"type": "finished", "outcome": "failed", "reason": "setup: first command must be 'run'"})
        return 2
    cancel_event = threading.Event()

    def watch_stdin():
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "cancel":
                cancel_event.set()
        # stdin closed: the gateway went away, treat as cancellation so the tab is released.
        if command.get("cancelOnStdinClose", True):
            cancel_event.set()

    threading.Thread(target=watch_stdin, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: cancel_event.set())
    result = run_command(command, emit, cancel_event)
    return 0 if result.get("outcome") == "extracted" else 1


if __name__ == "__main__":
    sys.exit(main())
