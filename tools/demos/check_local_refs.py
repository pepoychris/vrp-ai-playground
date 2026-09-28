"""Fail when a relative link or asset referenced by the README or the landing page is missing.

The GitHub Pages entry point lives at the repository root, so this guard also proves that
nothing still points at the retired `docs/` landing (`docs/index.html`, `docs/site.css`,
`docs/site.js`, `docs/assets/`).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RETIRED = ("docs/index.html", "docs/site.css", "docs/site.js", "docs/assets")


def check_label(text: str, source: Path, pattern: str) -> list[str]:
    problems: list[str] = []
    for target in sorted(set(re.findall(pattern, text))):
        if target.startswith(("http://", "https://", "mailto:", "data:", "#")):
            continue
        if not (ROOT / target.split("#", 1)[0]).exists():
            problems.append(f"{source.name}: missing target {target}")
    for retired in RETIRED:
        if retired in text:
            problems.append(f"{source.name}: still points at the retired {retired}")
    return problems


def main() -> int:
    problems: list[str] = []
    readme = (ROOT / "README.md").read_text(encoding="utf8")
    problems += check_label(readme, ROOT / "README.md", r"!?\[[^\]]*\]\(([^)\s]+)")

    landing = (ROOT / "index.html").read_text(encoding="utf8")
    problems += check_label(landing, ROOT / "index.html", r'(?:src|href)="([^"#]+)"')

    for problem in problems:
        print(problem)
    print("local reference check:", "FAIL" if problems else "OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
