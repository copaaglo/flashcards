import logging
import os
import time
from pathlib import Path

import anthropic
from prometheus_client import Counter
from pydantic import BaseModel

MODEL = os.environ.get("LLM_MODEL", "claude-opus-5-5")
FAKE_LLM = os.environ.get("FAKE_LLM") == "1"
# Fake mode only: pretend the model takes this long, so a local queue can actually back up
FAKE_LLM_DELAY_SECONDS = float(os.environ.get("FAKE_LLM_DELAY_SECONDS", "0"))
MAX_CHARS = 300_000  # fail loudly instead of silently cutting the lecture off

# Prompts live in versioned files so prompt changes show up in Git diffs
PROMPT = (Path(__file__).parent / "prompts" / "flashcards_v1.txt").read_text()

# US dollars per million tokens (input, output), from Anthropic's pricing page.
# Thinking tokens are billed as output and are included in usage.output_tokens.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
}

log = logging.getLogger("rq.worker")

LLM_TOKENS = Counter("flashcards_llm_tokens", "Tokens used by LLM calls", ["model", "direction"])
LLM_COST = Counter("flashcards_llm_cost_dollars", "Estimated LLM spend in US dollars", ["model"])


class Card(BaseModel):
    question: str
    answer: str


class StudySet(BaseModel):
    summary: str
    cards: list[Card]


def generate_study_set(text: str) -> StudySet:
    if FAKE_LLM:
        time.sleep(FAKE_LLM_DELAY_SECONDS)
        first_line = text.strip().splitlines()[0][:100]
        return StudySet(
            summary=f"(fake) This lecture starts with: {first_line}",
            cards=[
                Card(question=f"(fake) Question {i}?", answer=f"(fake) Answer {i}")
                for i in range(1, 4)
            ],
        )

    if len(text) > MAX_CHARS:
        raise ValueError(f"Lecture is too long ({len(text)} chars, max {MAX_CHARS})")

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=PROMPT,
        messages=[{"role": "user", "content": f"<lecture>\n{text}\n</lecture>"}],
        output_config={"effort": "low"},
        output_format=StudySet,  # the SDK forces valid JSON matching this schema
    )
    record_usage(response.usage)
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to process this document")
    return response.parsed_output


def record_usage(usage) -> None:
    """Count tokens and estimated cost. Refusals are billed too, so this runs for every call."""
    LLM_TOKENS.labels(model=MODEL, direction="input").inc(usage.input_tokens)
    LLM_TOKENS.labels(model=MODEL, direction="output").inc(usage.output_tokens)
    if MODEL not in PRICES:
        log.warning("No price for model %s, cost metric not updated", MODEL)
        return
    input_price, output_price = PRICES[MODEL]
    cost = (usage.input_tokens * input_price + usage.output_tokens * output_price) / 1_000_000
    LLM_COST.labels(model=MODEL).inc(cost)
    log.info(
        "llm model=%s input_tokens=%d output_tokens=%d cost_usd=%.4f",
        MODEL,
        usage.input_tokens,
        usage.output_tokens,
        cost,
    )
