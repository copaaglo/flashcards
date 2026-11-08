"""Check that the docs still match the repo. Runs in CI, needs only the Python standard library.

Usage, from the repo root:
    python scripts/check-docs.py                     checks README.md and docs/**/*.md
    python scripts/check-docs.py some/file.md        checks just that file

Three checks, each one a way docs go stale without anyone noticing:
  1. Every relative link [text](path) points to a file or folder that exists.
  2. Every repo path in backticks, like `deploy/helm/flashcards/values.yaml`, exists.
     Rename a file and forget the README, and CI tells you.
  3. No TODO(you) markers are left. The guide uses them for numbers only you can fill in.

Exit code 0 if everything checks out, 1 if not.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# [text](target) and ![alt](target). Stops at a space so "(path "title")" still works.
LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)[^)]*\)")
# `something/with/a/slash`, no spaces inside
CODE_PATH = re.compile(r"`([^`\s]+/[^`\s]*)`")
TODO = re.compile(r"TODO\(you\)")
FENCE = re.compile(r"^\s*(```|~~~)")


def top_level_names() -> set[str]:
    """Folders and files at the repo root. A backticked path only counts if it starts with one."""
    return {p.name for p in ROOT.iterdir() if p.name != ".git"}


def prose_lines(text: str):
    """Yield (line number, line) for lines outside fenced code blocks.

    Code blocks hold commands and diagrams, not claims about which files exist.
    """
    in_fence = False
    for number, line in enumerate(text.splitlines(), start=1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield number, line


def check_file(path: Path, roots: set[str]) -> list[tuple[int, str]]:
    problems = []
    text = path.read_text(encoding="utf-8")

    for number, line in enumerate(text.splitlines(), start=1):
        if TODO.search(line):
            problems.append((number, "TODO(you) left in the docs, fill it in"))

    for number, line in prose_lines(text):
        for target in LINK.findall(line):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
                continue  # https:, mailto:, or a heading on the same page
            file_part = target.split("#", 1)[0]
            if not (path.parent / file_part).exists():
                problems.append((number, f"broken link: {target}"))

        # Inline code spans only: drop everything inside [...](...) link targets first
        for candidate in CODE_PATH.findall(LINK.sub("", line)):
            if any(ch in candidate for ch in "<>*{}$"):
                continue  # a pattern or placeholder, not a real path
            if candidate.split("/", 1)[0] not in roots:
                continue  # not a repo path (a URL piece, a MIME type, "main/HEAD"...)
            if not (ROOT / candidate).exists():
                problems.append((number, f"path in backticks doesn't exist: {candidate}"))

    return problems


def main(argv: list[str]) -> int:
    if argv:
        files = [Path(a).resolve() for a in argv]
    else:
        files = [ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]

    roots = top_level_names()
    failed = 0
    for path in files:
        if not path.exists():
            print(f"::error::{path} not found")
            failed += 1
            continue
        relative = path.relative_to(ROOT)
        for number, message in check_file(path, roots):
            # GitHub Actions turns this format into a red note on the PR's Files tab
            print(f"::error file={relative},line={number}::{message}")
            failed += 1

    if failed:
        print(f"{failed} problem(s) found in the docs")
        return 1
    print(f"Docs OK: {len(files)} file(s) checked")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
