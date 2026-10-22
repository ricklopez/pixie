"""Check handoff files and Git hygiene; not an application/security test."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
required = ["README.md", "product-overview.md", "spec.md", "demo.md", "DEVIN_HANDOFF.md", "AGENTS.md", "docs/coderabbit.md", ".gitignore", ".env.example"]
for name in required:
    assert (root / name).is_file(), f"Missing {name}"
    assert (root / name).read_text().strip(), f"Empty {name}"
config = json.loads((root / ".coderabbit.yaml").read_text())
assert config["reviews"]["auto_review"]["enabled"] is True
assert config["reviews"]["auto_review"]["auto_incremental_review"] is True
tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
for name in filter(None, tracked):
    path = Path(name)
    assert not (path.name == ".env" or (path.name.startswith(".env.") and path.name != ".env.example")), f"Tracked environment file: {name}"
    assert not set(path.parts) & {"recordings", "evidence", "browser-data", "profiles", "artifacts"}, f"Tracked runtime data: {name}"
    assert path.suffix not in {".pem", ".key", ".sqlite", ".sqlite3", ".db"}, f"Tracked sensitive/runtime file: {name}"
print("Repository handoff files and tracked-file hygiene checks passed; application tests not implemented.")
