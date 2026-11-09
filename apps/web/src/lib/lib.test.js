// Unit tests for the pure logic. Run with: npm test (Node's built-in test runner, no extra packages)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, dateKey, daysBetween, formatMinutes, nextTest, startOfWeek } from "./dates.js";
import { addStudyDay, deckStats, recordAnswer, shakyIndices, streak } from "./progress.js";
import { buildQuestion, shuffle } from "./quiz.js";
import { nextTheme, themeName } from "./themes.js";

// Deterministic "random" so tests don't flake
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const cards = (...answers) => answers.map((a, i) => ({ question: `Q${i}`, answer: a }));

describe("buildQuestion", () => {
  it("makes 4 options with exactly one correct answer", () => {
    const q = buildQuestion(cards("a", "b", "c", "d", "e"), 0, seeded());
    assert.equal(q.mode, "choice");
    assert.equal(q.options.length, 4);
    assert.deepEqual(q.options.filter((o) => o.correct).map((o) => o.text), ["a"]);
  });

  it("never repeats the right answer as a wrong option, ignoring case and spaces", () => {
    const q = buildQuestion(cards("Theta(n)", " theta(n) ", "x", "y"), 0, seeded());
    assert.equal(q.options.length, 3);
    assert.equal(q.options.filter((o) => o.text.trim().toLowerCase() === "theta(n)").length, 1);
  });

  it("falls back to flip mode when there aren't 2 distinct wrong answers", () => {
    assert.equal(buildQuestion(cards("a", "b"), 0).mode, "flip");
    assert.equal(buildQuestion(cards("a"), 0).mode, "flip");
  });

  it("shuffle keeps every item", () => {
    assert.deepEqual(shuffle([1, 2, 3, 4], seeded()).sort(), [1, 2, 3, 4]);
  });
});

describe("progress", () => {
  const deck = { id: "d1", cards: cards("a", "b", "c") };

  it("counts learned, missed and unseen cards", () => {
    let p = recordAnswer({}, "d1", 0, true);
    p = recordAnswer(p, "d1", 1, false);
    assert.deepEqual(deckStats(deck, p), { total: 3, learned: 1, missed: 1, unseen: 1 });
    assert.deepEqual(shakyIndices(deck, p), [1, 2]);
  });

  it("uses the latest answer for a card", () => {
    let p = recordAnswer({}, "d1", 0, false);
    p = recordAnswer(p, "d1", 0, true);
    assert.deepEqual(p.d1[0], { last: true, seen: 2 });
  });
});

describe("streak", () => {
  const today = new Date(2026, 10, 10);
  const k = (n) => dateKey(addDays(today, n));

  it("counts consecutive days ending today", () => {
    assert.equal(streak([k(-2), k(-1), k(0)], today), 3);
  });
  it("still counts a streak that ended yesterday", () => {
    assert.equal(streak([k(-3), k(-2), k(-1)], today), 3);
  });
  it("resets after a missed day", () => {
    assert.equal(streak([k(-5), k(-2)], today), 0);
  });
  it("addStudyDay doesn't duplicate days", () => {
    assert.deepEqual(addStudyDay([k(0)], k(0)), [k(0)]);
  });
});

describe("dates", () => {
  it("weeks start on Monday", () => {
    assert.equal(startOfWeek(new Date(2026, 10, 15)).getDay(), 1);
  });
  it("daysBetween works across a month boundary", () => {
    assert.equal(daysBetween("2026-10-30", "2026-11-02"), 3);
  });
  it("nextTest skips past tests and finds the soonest one", () => {
    const sessions = {
      "2026-11-01": [{ title: "Old quiz", isTest: true }],
      "2026-11-13": [{ title: "Midterm", isTest: true }],
      "2026-11-11": [{ title: "Review", isTest: false }],
    };
    assert.deepEqual(nextTest(sessions, "2026-11-09"), { key: "2026-11-13", title: "Midterm", days: 4 });
    assert.equal(nextTest({}, "2026-11-09"), null);
  });
  it("formats minutes", () => {
    assert.equal(formatMinutes(45), "45 min");
    assert.equal(formatMinutes(90), "1h 30m");
  });
});

describe("themes", () => {
  it("gives a deck without a saved theme a stable one", () => {
    assert.equal(themeName({ id: "abc" }), themeName({ id: "abc" }));
  });
  it("picks the least used theme for a new deck", () => {
    assert.equal(nextTheme([]), "tangerine");
    assert.equal(nextTheme([{ theme: "tangerine" }]), "lilac");
  });
});
