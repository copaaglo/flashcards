import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CloseIcon, ShuffleIcon } from "./Icons.jsx";

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function StudyModal({ deck, onClose }) {
  const [cards, setCards] = useState(deck.cards);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const go = (n) => {
    setFlipped(false);
    setIndex((i) => Math.max(0, Math.min(cards.length - 1, i + n)));
  };

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") { setFlipped(false); setIndex((i) => Math.min(cards.length - 1, i + 1)); }
      else if (e.key === "ArrowLeft") { setFlipped(false); setIndex((i) => Math.max(0, i - 1)); }
      else if (e.key === " ") { e.preventDefault(); setFlipped((f) => !f); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, onClose]);

  const card = cards[index];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Study ${deck.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <p className="eyebrow">Studying</p>
            <h2>{deck.name}</h2>
          </div>
          <div className="row">
            <button
              className="icon-btn"
              aria-label="Shuffle"
              title="Shuffle"
              onClick={() => { setCards(shuffled(deck.cards)); setIndex(0); setFlipped(false); }}
            >
              <ShuffleIcon />
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
          </div>
        </div>

        <div className="progress"><span style={{ width: `${((index + 1) / cards.length) * 100}%` }} /></div>

        <button className={`flashcard${flipped ? " flipped" : ""}`} onClick={() => setFlipped((f) => !f)}>
          <span className="face front">
            <span className="eyebrow">Question</span>
            <span className="face-text">{card.question}</span>
            <span className="muted small">Click or press space to reveal</span>
          </span>
          <span className="face back">
            <span className="eyebrow">Answer</span>
            <span className="face-text">{card.answer}</span>
          </span>
        </button>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={() => go(-1)} disabled={index === 0}><ChevronLeft />Prev</button>
          <span className="muted">{index + 1} / {cards.length}</span>
          <button className="btn btn-primary" onClick={() => go(1)} disabled={index === cards.length - 1}>Next<ChevronRight /></button>
        </div>
      </div>
    </div>
  );
}
