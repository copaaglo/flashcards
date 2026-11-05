from scoring import (
    card_range,
    check_card_count,
    check_duplicates,
    check_grounding,
    check_schema,
    score,
)
from worker.llm import Card, StudySet

LECTURE = (
    "TCP is connection oriented and uses a three-way handshake. "
    "UDP is connectionless and has an 8 byte header. "
    "DNS queries usually use UDP because one small request is faster without a handshake."
)


def cards(*pairs):
    return StudySet(summary="TCP and UDP.", cards=[Card(question=q, answer=a) for q, a in pairs])


def test_schema_rejects_missing_fields_and_empty_text():
    assert check_schema({"summary": "S", "cards": [{"question": "Q?", "answer": "A"}]}) == 1.0
    assert check_schema({"summary": "S"}) == 0.0
    assert check_schema({"summary": "S", "cards": []}) == 0.0
    assert check_schema({"summary": "S", "cards": [{"question": " ", "answer": "A"}]}) == 0.0


def test_card_range_grows_with_lecture_length():
    assert card_range(200) == (5, 10)
    assert card_range(600) == (5, 15)
    assert card_range(5000) == (8, 20)


def test_card_count():
    three = cards(*[(f"Q{i}?", "A") for i in range(3)])
    seven = cards(*[(f"Q{i}?", "A") for i in range(7)])
    assert check_card_count(three, LECTURE) == 0.0  # short lecture still needs 5
    assert check_card_count(seven, LECTURE) == 1.0


def test_grounding_catches_answers_not_in_the_lecture():
    study_set = cards(
        ("How does TCP start a connection?", "With a three-way handshake."),
        ("Why does DNS use UDP?", "One small request is faster without a handshake."),
        ("Who invented TCP?", "Vint Cerf and Bob Kahn at DARPA in 1974."),  # not in the lecture
        ("Is UDP connection oriented?", "No."),  # nothing to check, counts as grounded
    )
    assert check_grounding(study_set, LECTURE) == 0.75


def test_fake_llm_cards_are_not_grounded():
    fake = cards(*[(f"(fake) Question {i}?", f"(fake) Answer {i}") for i in range(1, 4)])
    assert check_grounding(fake, LECTURE) == 0.0


def test_duplicates():
    study_set = cards(
        ("What handshake does TCP use?", "Three-way."),
        ("What handshake does TCP use?", "Three-way handshake."),  # exact repeat
        ("Which handshake is used by TCP?", "Three-way."),  # same words, new order
        ("How big is the UDP header?", "8 bytes."),
    )
    assert check_duplicates(study_set) == 0.5


def test_invalid_output_scores_zero_everywhere():
    assert set(score({"oops": True}, LECTURE).values()) == {0.0}
