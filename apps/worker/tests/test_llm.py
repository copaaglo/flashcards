from types import SimpleNamespace

import pytest

from worker import llm
from worker.llm import Card, StudySet


class FakeAnthropic:
    """Pretends to be anthropic.Anthropic(). Records requests, returns a canned response."""

    requests = []
    response = None

    def __init__(self, *args, **kwargs):
        self.messages = self

    def parse(self, **kwargs):
        FakeAnthropic.requests.append(kwargs)
        return FakeAnthropic.response


@pytest.fixture
def fake_client(monkeypatch):
    FakeAnthropic.requests = []
    FakeAnthropic.response = None
    monkeypatch.setattr(llm, "FAKE_LLM", False)
    monkeypatch.setattr(llm.anthropic, "Anthropic", FakeAnthropic)
    return FakeAnthropic


def test_fake_mode_returns_three_cards(monkeypatch):
    monkeypatch.setattr(llm, "FAKE_LLM", True)
    result = llm.generate_study_set("Lecture 3: TCP vs UDP\nmore text")
    assert len(result.cards) == 3
    assert "Lecture 3: TCP vs UDP" in result.summary


def test_sends_lecture_and_prompt_to_model(fake_client):
    expected = StudySet(summary="S", cards=[Card(question="Q?", answer="A")])
    fake_client.response = SimpleNamespace(stop_reason="end_turn", parsed_output=expected)

    result = llm.generate_study_set("Pascal's law")

    assert result == expected
    request = fake_client.requests[0]
    assert request["system"] == llm.PROMPT
    assert request["output_format"] is StudySet
    assert "<lecture>\nPascal's law\n</lecture>" in request["messages"][0]["content"]


def test_refusal_raises(fake_client):
    fake_client.response = SimpleNamespace(stop_reason="refusal", parsed_output=None)
    with pytest.raises(RuntimeError, match="declined"):
        llm.generate_study_set("some text")


def test_too_long_lecture_fails_before_calling_model(fake_client):
    with pytest.raises(ValueError, match="too long"):
        llm.generate_study_set("x" * (llm.MAX_CHARS + 1))
    assert fake_client.requests == []  # no money spent


def test_prompt_file_is_loaded():
    assert "flashcards" in llm.PROMPT.lower()
