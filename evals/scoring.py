"""Checks that score one study set against the lecture it came from.

Every check returns a number from 0.0 (bad) to 1.0 (good), so they can be averaged.
No LLM calls in here: these are cheap, deterministic checks (the "keyword overlap first"
part of the plan). An LLM-as-judge can be added later as one more check.
"""

import re
from difflib import SequenceMatcher

from pydantic import ValidationError

from worker.llm import StudySet, card_range

# Common words that say nothing about whether an answer came from the lecture
STOPWORDS = set(
    """a an and are as at be because been but by can do does for from has have how if in into
    is it its it's more most no not of on one or so such than that the their them then there
    these they this those to too two use used uses using was way we what when where which while
    who why will with would you your also each every other only very about after before both
    same than over under between""".split()
)


def words(text: str) -> list[str]:
    """Lowercase content words, with a crude plural strip so "cards" matches "card"."""
    found = re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower())
    return [w.removesuffix("s") if len(w) > 4 else w for w in found if w not in STOPWORDS]


def check_schema(raw: dict) -> float:
    """1.0 if the output parses as a StudySet with no empty fields."""
    try:
        study_set = StudySet.model_validate(raw)
    except ValidationError:
        return 0.0
    texts = [study_set.summary] + [t for c in study_set.cards for t in (c.question, c.answer)]
    return 1.0 if study_set.cards and all(t.strip() for t in texts) else 0.0


def check_card_count(study_set: StudySet, lecture: str) -> float:
    low, high = card_range(len(lecture.split()))
    return 1.0 if low <= len(study_set.cards) <= high else 0.0


def grounded(answer: str, lecture_words: set[str], min_overlap: float = 0.5) -> bool:
    """An answer is grounded if most of its content words appear in the lecture."""
    answer_words = words(answer)
    if not answer_words:
        return True  # "Yes." or "1789" has no content words to check
    found = sum(w in lecture_words for w in answer_words)
    return found / len(answer_words) >= min_overlap


def check_grounding(study_set: StudySet, lecture: str) -> float:
    """Share of cards whose answers come from the lecture text."""
    if not study_set.cards:
        return 0.0
    lecture_words = set(words(lecture))
    return sum(grounded(c.answer, lecture_words) for c in study_set.cards) / len(study_set.cards)


def near_duplicate(q1: str, q2: str) -> bool:
    w1, w2 = set(words(q1)), set(words(q2))
    jaccard = len(w1 & w2) / len(w1 | w2) if w1 | w2 else 1.0
    similar_text = SequenceMatcher(None, q1.lower(), q2.lower()).ratio()
    return jaccard >= 0.8 or similar_text >= 0.9


def check_duplicates(study_set: StudySet) -> float:
    """1.0 means no two questions are (nearly) the same."""
    questions = [c.question for c in study_set.cards]
    if not questions:
        return 0.0
    duplicates = {
        j
        for i in range(len(questions))
        for j in range(i + 1, len(questions))
        if near_duplicate(questions[i], questions[j])
    }
    return 1 - len(duplicates) / len(questions)


def score(raw: dict, lecture: str) -> dict[str, float]:
    """All checks for one sample. Everything is 0 if the output isn't even valid."""
    schema = check_schema(raw)
    if not schema:
        return {"schema": 0.0, "card_count": 0.0, "grounding": 0.0, "no_duplicates": 0.0}
    study_set = StudySet.model_validate(raw)
    return {
        "schema": schema,
        "card_count": check_card_count(study_set, lecture),
        "grounding": check_grounding(study_set, lecture),
        "no_duplicates": check_duplicates(study_set),
    }
