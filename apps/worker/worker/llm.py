import os
from pathlib import Path

import anthropic
from pydantic import BaseModel

MODEL = os.environ.get("LLM_MODEL", "claude-opus-5-5")
FAKE_LLM = os.environ.get("FAKE_LLM") == "1"
MAX_CHARS = 300_000  # fail loudly instead of silently cutting the lecture off

# Prompts live in versioned files so prompt changes show up in Git diffs
PROMPT = (Path(__file__).parent / "prompts" / "flashcards_v1.txt").read_text()


class Card(BaseModel):
    question: str
    answer: str


class StudySet(BaseModel):
    summary: str
    cards: list[Card]


def generate_study_set(text: str) -> StudySet:
    if FAKE_LLM:
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
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to process this document")
    return response.parsed_output
