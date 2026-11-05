"""Run every lecture in evals/samples through the real prompt and model, and score the output.

Usage, from the repo root (needs ANTHROPIC_API_KEY, costs a few cents per run):
    python evals/run_evals.py
    python evals/run_evals.py --threshold 0.9
    FAKE_LLM=1 python evals/run_evals.py      (free, and should FAIL: fake cards are garbage)

Exit code 0 if the overall score is at or above the threshold, 1 if not. That exit code
is what makes this a quality gate in CI.
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Use the worker's real code (prompt, model settings, PDF extraction), not a copy of it
sys.path.insert(0, str(ROOT.parent / "apps" / "worker"))
# worker.tasks reads these when imported. Nothing here talks to a database or S3.
for name, value in {"DATABASE_URL": "unused", "S3_BUCKET": "unused"}.items():
    os.environ.setdefault(name, value)

from scoring import score  # noqa: E402
from worker.llm import MODEL, generate_study_set  # noqa: E402
from worker.tasks import extract_text  # noqa: E402

SAMPLES = ROOT / "samples"
RESULTS = ROOT / "results"
CHECKS = ["schema", "card_count", "grounding", "no_duplicates"]


def load_lecture(path: Path) -> str:
    if path.suffix == ".pdf":
        return extract_text(path.read_bytes())  # same extraction the worker does
    return path.read_text()


def run_sample(path: Path) -> dict:
    lecture = load_lecture(path)
    try:
        raw = generate_study_set(lecture).model_dump()
    except Exception as e:  # one broken sample shouldn't hide the others' results
        return {
            "sample": path.name,
            "error": f"{type(e).__name__}: {e}",
            "output": None,
            "scores": dict.fromkeys(CHECKS, 0.0),
        }
    return {"sample": path.name, "error": None, "output": raw, "scores": score(raw, lecture)}


def summary_table(results: list[dict], overall: float, threshold: float) -> str:
    lines = [
        "| Sample | Cards | " + " | ".join(CHECKS) + " |",
        "|---|---|" + "---|" * len(CHECKS),
    ]
    for r in results:
        cards = len(r["output"]["cards"]) if r["output"] else "error"
        cells = " | ".join(f"{r['scores'][c]:.2f}" for c in CHECKS)
        lines.append(f"| {r['sample']} | {cards} | {cells} |")
    verdict = "PASS" if overall >= threshold else "FAIL"
    lines.append("")
    lines.append(f"**Overall: {overall:.3f}** (threshold {threshold}): **{verdict}**")
    lines.append(f"Model `{MODEL}`, {len(results)} samples")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("EVAL_THRESHOLD", "0.93")),
        help="lowest overall score that passes (default 0.93)",
    )
    args = parser.parse_args()

    samples = sorted(p for p in SAMPLES.iterdir() if p.suffix in {".txt", ".pdf"})
    print(f"Running {len(samples)} samples through {MODEL}...", flush=True)
    # A few at a time: faster than one by one, gentler on rate limits than all at once
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run_sample, samples))

    per_sample = [sum(r["scores"].values()) / len(CHECKS) for r in results]
    overall = sum(per_sample) / len(per_sample)
    table = summary_table(results, overall, args.threshold)
    print(table)
    for r in results:
        if r["error"]:
            print(f"ERROR in {r['sample']}: {r['error']}")

    # Full outputs, so you can read the actual cards behind a bad score
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "latest.json").write_text(
        json.dumps(
            {"model": MODEL, "overall": overall, "threshold": args.threshold, "results": results},
            indent=2,
        )
    )
    # In GitHub Actions, the same table shows up on the run's summary page
    if summary_file := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary_file, "a") as f:
            f.write("## AI evals\n\n" + table + "\n")

    return 0 if overall >= args.threshold else 1


if __name__ == "__main__":
    sys.exit(main())
