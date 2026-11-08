import { useEffect, useRef, useState } from "react";
import { CloseIcon, TrashIcon } from "./Icons.jsx";

const CHIPS = [15, 20, 30, 45, 60];
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

// Rendered with a fresh `key` each time it opens, so state starts from props
export default function QuickAddSheet({ dayKey, session, decks, onSave, onDelete, onClose }) {
  const [title, setTitle] = useState(session?.title ?? "");
  const [notes, setNotes] = useState(session?.notes ?? "");
  const [isTest, setIsTest] = useState(session?.isTest ?? false);
  const [minutes, setMinutes] = useState(session?.minutes ?? 30);
  const [custom, setCustom] = useState(session && !CHIPS.includes(session.minutes));
  const [deckId, setDeckId] = useState(session?.deckId ?? "");
  const titleRef = useRef(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [y, m, d] = dayKey.split("-").map(Number);
  const readyDecks = decks.filter((dk) => dk.status === "done");

  function pickDeck(id) {
    setDeckId(id);
    const deck = decks.find((dk) => dk.id === id);
    if (deck && !title.trim()) setTitle(`Review ${deck.name}`);
  }

  function submit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({
      id: session?.id ?? crypto.randomUUID(),
      title: title.trim(),
      notes: notes.trim(),
      isTest,
      minutes: Math.max(5, Math.min(600, Number(minutes) || 30)),
      deckId: deckId || null,
      done: session?.done ?? false,
    });
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-label="Plan a session" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <p className="eyebrow">{session ? "Edit session" : "New session"}</p>
            <h2>{longDate.format(new Date(y, m - 1, d))}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>

        <form className="sheet-body" onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Cell biology chapter 3"
              required
            />
          </label>

          <label className="field">
            <span>Deck <em className="muted">(optional)</em></span>
            <select value={deckId} onChange={(e) => pickDeck(e.target.value)}>
              <option value="">No deck</option>
              {readyDecks.map((dk) => (
                <option key={dk.id} value={dk.id}>{dk.name} · {dk.cards.length} cards</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Notes <em className="muted">(optional)</em></span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What to focus on" />
          </label>

          <label className="toggle">
            <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
            <span>
              <strong>This is a test</strong>
              <span className="muted small block">Marked in amber and left out of study time</span>
            </span>
          </label>

          <div className="field">
            <span>Duration</span>
            <div className="chips">
              {CHIPS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`chip${!custom && minutes === c ? " on" : ""}`}
                  onClick={() => { setCustom(false); setMinutes(c); }}
                >
                  {c}m
                </button>
              ))}
              <button type="button" className={`chip${custom ? " on" : ""}`} onClick={() => setCustom(true)}>
                Custom
              </button>
            </div>
            {custom && (
              <div className="custom-min">
                <input type="number" min={5} max={600} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                <span className="muted">minutes</span>
              </div>
            )}
          </div>

          <div className="sheet-actions">
            {session && (
              <button type="button" className="btn btn-danger" onClick={() => onDelete(session.id)}>
                <TrashIcon /> Delete
              </button>
            )}
            <span className="muted small hint">Press Enter to save</span>
            <button type="submit" className="btn btn-primary">{session ? "Save" : "Add session"}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}
