# 0005: AI evals as a merge gate

**Status:** Accepted (Phase 6, week 7)

## Context

Unit tests mock the LLM, so they prove the plumbing works but say nothing about whether the cards are any good. A one-word prompt change, or a new model version, can make every deck worse while every test stays green. LLM output also isn't deterministic, so "same output as last time" can't be the test.

## Decision

`evals/run_evals.py` runs every lecture in `evals/samples/` through the worker's real code and model, and scores each result on four checks: valid schema, card count in range for the lecture's length, answers grounded in the source (keyword overlap), and no duplicate cards. If the overall score is below the threshold, it exits 1 and the **CI passed** check fails.

It only runs on PRs that touch `apps/worker/`, `evals/` or `ci.yml`, detected with `git diff` in a `changes` job. CI uses its own Anthropic key with a spend limit.

## Consequences

- A prompt change that makes cards worse can't merge, and the PR shows exactly which lecture and which check dropped (results are uploaded as a run artifact).
- Each eval run costs a few cents and a few minutes. The path filter keeps that to the PRs that can change the output.
- The threshold was set from baseline runs, with room for normal run-to-run variation. Too tight and it fails randomly; too loose and it catches nothing.
- Keyword overlap can't catch a wrong answer that uses the right words. LLM-as-judge is the next step.
- The eval set is eight short lectures. It should grow from real failures: every bad deck someone reports becomes a sample.
