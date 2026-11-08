import { addDays, dateKey } from "./dates.js";

// progress = { [deckId]: { [cardIndex]: { last: true|false, seen: n } } }
// Kept in localStorage, like decks and sessions (the API has no user storage yet).

export function recordAnswer(progress, deckId, cardIndex, correct) {
  const deck = progress[deckId] ?? {};
  const prev = deck[cardIndex] ?? { seen: 0 };
  return { ...progress, [deckId]: { ...deck, [cardIndex]: { last: correct, seen: prev.seen + 1 } } };
}

export function deckStats(deck, progress) {
  const p = progress[deck.id] ?? {};
  const total = deck.cards?.length ?? 0;
  let learned = 0;
  let missed = 0;
  for (let i = 0; i < total; i++) {
    if (p[i]?.last === true) learned++;
    else if (p[i]?.last === false) missed++;
  }
  return { total, learned, missed, unseen: total - learned - missed };
}

// Cards not answered right the last time (missed or never seen)
export function shakyIndices(deck, progress) {
  const p = progress[deck.id] ?? {};
  return (deck.cards ?? []).map((_, i) => i).filter((i) => p[i]?.last !== true);
}

// Consecutive days studied, ending today. If today has no study yet, a streak
// that ended yesterday still counts (you haven't broken it until the day is over).
export function streak(studyDays, today = new Date()) {
  const days = new Set(studyDays);
  let cursor = days.has(dateKey(today)) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(dateKey(cursor))) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

export function addStudyDay(studyDays, key) {
  if (studyDays.includes(key)) return studyDays;
  // Only the last 400 days matter for a streak
  return [...studyDays, key].sort().slice(-400);
}
