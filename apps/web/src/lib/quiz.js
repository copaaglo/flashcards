// Turns plain question/answer cards into multiple choice questions.
// The wrong options are answers from other cards in the same deck, so no extra AI call is needed.

export function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

// Returns { mode: "choice", options: [{ text, correct }] } with 3 or 4 options,
// or { mode: "flip" } when the deck is too small to make believable wrong answers.
export function buildQuestion(cards, index, rand = Math.random) {
  const answer = String(cards[index].answer ?? "").trim();
  const seen = new Set([norm(answer)]);
  const pool = [];
  cards.forEach((c, i) => {
    const text = String(c.answer ?? "").trim();
    if (i === index || !text || seen.has(norm(text))) return;
    seen.add(norm(text));
    pool.push(text);
  });
  if (pool.length < 2) return { mode: "flip" };
  const wrong = shuffle(pool, rand).slice(0, 3).map((text) => ({ text, correct: false }));
  return { mode: "choice", options: shuffle([{ text: answer, correct: true }, ...wrong], rand) };
}

// Options read better in one column when any of them is long
export const isLongOptionSet = (options) => options.some((o) => o.text.length > 70);
