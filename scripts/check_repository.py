"""Check prototype docs and Git hygiene; not an application/security test."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
required = [
    "README.md",
    "PROVENANCE.md",
    "docs/prototype/product-overview.md",
    "docs/prototype/spec.md",
    "docs/prototype/demo.md",
    "docs/prototype/DEVIN_HANDOFF.md",
    "docs/prototype/AGENTS.md",
    ".gitignore",
    ".env.example",
]
for name in required:
    assert (root / name).is_file(), f"Missing {name}"
    assert (root / name).read_text().strip(), f"Empty {name}"
package = json.loads((root / "package.json").read_text())
assert package["name"] == "pixie"
assert "sites/*" not in package["workspaces"]
tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
for name in filter(None, tracked):
    path = Path(name)
    assert not (path.name == ".env" or (path.name.startswith(".env.") and path.name != ".env.example")), f"Tracked environment file: {name}"
    assert not set(path.parts) & {"recordings", "evidence", "browser-data", "profiles", "artifacts"}, f"Tracked runtime data: {name}"
    assert path.suffix not in {".pem", ".key", ".sqlite", ".sqlite3", ".db"}, f"Tracked sensitive/runtime file: {name}"
print("Repository handoff files and tracked-file hygiene checks passed; application tests not implemented.")
