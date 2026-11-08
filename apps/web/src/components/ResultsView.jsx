import { useEffect, useRef } from "react";
import { themeOf } from "../lib/themes.js";
import { Button, Chip } from "./ui.jsx";

function verdict(pct) {
  if (pct >= 90) return "Crushed it.";
  if (pct >= 70) return "Solid session.";
  if (pct >= 40) return "Getting there.";
  return "Tough one. Run the misses again.";
}

function duration(ms) {
  const min = Math.round(ms / 60000);
  return min < 1 ? "<1m" : `${min}m`;
}

function Stat({ label, value }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-white p-5">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      <span className="font-display text-h1 font-extrabold">{value}</span>
    </div>
  );
}

export default function ResultsView({ deck, result, streakDays, onRedo, onClose }) {
  const theme = themeOf(deck);
  const heading = useRef(null);
  const total = result.answers.length;
  const right = result.answers.filter((a) => a.correct).length;
  const missed = result.answers.filter((a) => !a.correct);
  const pct = total ? Math.round((right / total) * 100) : 0;

  useEffect(() => heading.current?.focus(), []);

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-paper" role="dialog" aria-modal="true" aria-labelledby="results-h">
      <div className="mx-auto grid max-w-310 gap-6 px-4 py-8 sm:px-8 lg:grid-cols-[5fr_7fr] lg:py-12">
        <section className={`flex flex-col justify-between gap-8 rounded-card p-8 sm:p-10 ${theme.bg} ${theme.text}`}>
          <span className="text-xs font-bold tracking-wider uppercase">Session done, {deck.name}</span>
          <div className="flex flex-col gap-3">
            <p className="font-display text-[6rem] leading-[0.9] font-extrabold tracking-tighter tabular-nums sm:text-score" aria-label={`${right} out of ${total}`}>
              {right}<span className="text-h1 tracking-tight sm:text-display">/{total}</span>
            </p>
            <h1 id="results-h" ref={heading} tabIndex={-1} className="text-h2 font-extrabold tracking-tight focus:outline-none">
              {verdict(pct)}
            </h1>
          </div>
          <div className="flex flex-wrap gap-3">
            {missed.length > 0 && (
              <Button size="lg" onClick={() => onRedo(missed.map((a) => a.index))} className={theme.text === "text-white" ? "bg-white text-ink hover:bg-white/85" : ""}>
                Redo {missed.length} missed {missed.length === 1 ? "card" : "cards"}
              </Button>
            )}
            <Button size="lg" variant={missed.length ? "outline" : "primary"} onClick={onClose}>
              Back home
            </Button>
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-6">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Accuracy" value={`${pct}%`} />
            <Stat label="Time" value={duration(result.ms)} />
            <Stat label="Streak" value={`${streakDays}d`} />
          </div>

          <div className="flex flex-col rounded-card border border-line bg-white px-6 py-2">
            <div className="flex items-center justify-between gap-4 border-b border-line py-4">
              <h2 className="text-title font-semibold">{missed.length ? "Cards you missed" : "No misses"}</h2>
              <Chip>{missed.length} of {total}</Chip>
            </div>
            {missed.length === 0 && <p className="py-4 text-ink-2">You got every card right. Those cards count as learned now.</p>}
            <ul className="divide-y divide-line">
              {missed.map((a) => {
                const card = deck.cards[a.index];
                return (
                  <li key={a.index} className="flex gap-4 py-4">
                    <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${theme.bg}`} aria-hidden="true" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-bold break-words">{card.question}</span>
                      <span className="text-sm break-words text-ink-2">
                        {a.picked ? `You picked "${a.picked}". ` : ""}Answer: {card.answer}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
