import { useEffect, useMemo, useRef, useState } from "react";
import { buildQuestion, isLongOptionSet } from "../lib/quiz.js";
import { themeOf } from "../lib/themes.js";
import { CheckIcon, CloseIcon } from "./Icons.jsx";
import { Button, ProgressBar } from "./ui.jsx";

const KEYS = ["1", "2", "3", "4"];

// Full-screen quiz over `order` (card indices). Calls onAnswer per card and onFinish at the end.
export default function StudyView({ deck, order, onAnswer, onFinish, onClose }) {
  const theme = themeOf(deck);
  const [pos, setPos] = useState(0);
  const [picked, setPicked] = useState(null); // option index, or "revealed" / true / false in flip mode
  const answers = useRef([]);
  const [startedAt] = useState(() => Date.now());
  const nextRef = useRef(null);

  const cardIndex = order[pos];
  const card = deck.cards[cardIndex];
  // Built once per card, so options don't reshuffle on every render
  const q = useMemo(() => buildQuestion(deck.cards, cardIndex), [deck.cards, cardIndex]);
  const answered = q.mode === "choice" ? picked !== null : picked === true || picked === false;

  function grade(correct, pickedText = null) {
    answers.current.push({ index: cardIndex, correct, picked: pickedText });
    onAnswer(cardIndex, correct);
  }

  function choose(i) {
    if (picked !== null) return;
    setPicked(i);
    grade(q.options[i].correct, q.options[i].text);
  }

  function selfGrade(correct) {
    setPicked(correct);
    grade(correct);
  }

  function next() {
    if (pos + 1 >= order.length) {
      onFinish({ answers: answers.current, ms: Date.now() - startedAt });
      return;
    }
    setPos(pos + 1);
    setPicked(null);
  }

  // Move focus to "Next" after answering, so Enter or Space continues
  useEffect(() => {
    if (answered) nextRef.current?.focus();
  }, [answered]);

  useEffect(() => {
    function onKey(e) {
      if (e.target.closest?.("input, textarea, select")) return;
      if (e.key === "Escape") onClose();
      else if (q.mode === "choice" && picked === null && KEYS.includes(e.key)) {
        const i = Number(e.key) - 1;
        if (i < q.options.length) choose(i);
      } else if (q.mode === "flip" && picked === null && e.key === " ") {
        e.preventDefault();
        setPicked("revealed");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const right = answered && (q.mode === "choice" ? q.options[picked].correct : picked === true);

  return (
    <div className={`fixed inset-0 z-40 flex flex-col overflow-y-auto ${theme.bg} ${theme.text}`} role="dialog" aria-modal="true" aria-label={`Studying ${deck.name}`}>
      <header className="mx-auto flex w-full max-w-310 items-center gap-4 px-4 py-5 sm:px-8">
        <button
          type="button"
          onClick={onClose}
          aria-label="End session"
          className="grid size-11 shrink-0 place-items-center rounded-control border-[1.5px] border-current hover:bg-ink/10"
        >
          <CloseIcon />
        </button>
        <ProgressBar value={pos + (answered ? 1 : 0)} max={order.length} label="Session progress" track={theme.soft} bar={theme.bar} className="h-2.5 flex-1" />
        <span className="font-bold tabular-nums">{pos + 1} / {order.length}</span>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center sm:px-8">
        <div className="flex w-full max-w-205 flex-col gap-7 rounded-card bg-paper p-6 text-ink sm:p-10">
          <div className="flex flex-col gap-2.5">
            <span className="text-xs font-bold tracking-wider text-ink-2 uppercase">{deck.name}</span>
            <h1 className="text-title font-extrabold tracking-tight break-words sm:text-h2">{card.question}</h1>
          </div>

          {q.mode === "choice" ? (
            <div className={`grid gap-3 ${isLongOptionSet(q.options) ? "" : "sm:grid-cols-2"}`}>
              {q.options.map((o, i) => {
                const state = picked === null ? "idle" : o.correct ? "right" : i === picked ? "wrong" : "dim";
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => choose(i)}
                    disabled={picked !== null}
                    className={`flex min-h-16 items-center gap-3 rounded-tile border-2 px-4 py-3 text-left font-medium transition-colors disabled:cursor-default ${
                      state === "idle" ? "border-line bg-white hover:border-ink" :
                      state === "right" ? "border-ink bg-right" :
                      state === "wrong" ? "border-ink bg-wrong" : "border-line bg-white opacity-50"
                    }`}
                  >
                    <span className={`grid size-8 shrink-0 place-items-center rounded-control text-sm font-bold ${state === "right" || state === "wrong" ? "bg-ink text-white" : "bg-sunken"}`}>
                      {state === "right" ? <CheckIcon width={14} height={14} /> : state === "wrong" ? <CloseIcon width={14} height={14} /> : KEYS[i]}
                    </span>
                    <span className="break-words">{o.text}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-tile border-2 border-dashed border-line p-5">
              {picked === null ? (
                <Button variant="outline" onClick={() => setPicked("revealed")}>Show answer</Button>
              ) : (
                <p className="text-lg break-words">{card.answer}</p>
              )}
            </div>
          )}

          <div aria-live="polite" className="min-h-13">
            {q.mode === "flip" && picked === "revealed" && (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <span className="text-ink-2">Did you get it?</span>
                <div className="flex gap-3">
                  <Button variant="outline" size="lg" onClick={() => selfGrade(false)}>Missed it</Button>
                  <Button size="lg" onClick={() => selfGrade(true)}>Got it</Button>
                </div>
              </div>
            )}
            {answered && (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-display text-title font-extrabold">{right ? "Nice, that's it." : "Not quite."}</span>
                  {!right && q.mode === "choice" && (
                    <span className="text-sm break-words text-ink-2">Answer: {card.answer}</span>
                  )}
                </div>
                <Button ref={nextRef} size="lg" onClick={next}>
                  {pos + 1 >= order.length ? "See results" : "Next card"}
                </Button>
              </div>
            )}
            {!answered && picked === null && (
              <span className="text-xs text-ink-2">
                {q.mode === "choice" ? "Pick an answer, or press 1 to " + q.options.length : "Try to answer in your head first, then press Space"}
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
