import { useEffect, useRef, useState } from "react";
import { parseKey } from "../lib/dates.js";
import { CloseIcon, TrashIcon } from "./Icons.jsx";
import { Button, IconButton } from "./ui.jsx";

const CHIPS = [15, 20, 30, 45, 60];
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

const FIELD = "w-full rounded-control border-[1.5px] border-line bg-white px-3.5 py-2.5 text-base placeholder:text-ink-2/70 focus:border-ink focus:outline-none";

// A native <dialog>: the browser handles focus trapping, Esc and the backdrop for us.
// Rendered with a fresh `key` each time it opens, so state starts from props.
export default function SessionDialog({ dayKey, session, decks, onSave, onDelete, onClose }) {
  const ref = useRef(null);
  const [title, setTitle] = useState(session?.title ?? "");
  const [notes, setNotes] = useState(session?.notes ?? "");
  const [isTest, setIsTest] = useState(session?.isTest ?? false);
  const [minutes, setMinutes] = useState(session?.minutes ?? 30);
  const [custom, setCustom] = useState(Boolean(session) && !CHIPS.includes(session.minutes));
  const [deckId, setDeckId] = useState(session?.deckId ?? "");

  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const readyDecks = decks.filter((d) => d.status === "done" && d.cards.length);

  function pickDeck(id) {
    setDeckId(id);
    const deck = decks.find((d) => d.id === id);
    if (deck && !title.trim()) setTitle(deck.name);
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
    <dialog
      ref={ref}
      aria-labelledby="session-h"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-card bg-paper p-0 text-ink shadow-overlay"
    >
      <form onSubmit={submit} className="flex flex-col gap-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-wider text-ink-2 uppercase">{session ? "Edit session" : "New session"}</p>
            <h2 id="session-h" className="text-title font-semibold">{longDate.format(parseKey(dayKey))}</h2>
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-2 -mr-2"><CloseIcon /></IconButton>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">What are you studying?</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Algorithms chapter 3" required className={FIELD} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Deck <span className="font-normal text-ink-2">(optional)</span></span>
          <select value={deckId} onChange={(e) => pickDeck(e.target.value)} className={FIELD}>
            <option value="">No deck</option>
            {readyDecks.map((d) => (
              <option key={d.id} value={d.id}>{d.name} ({d.cards.length} cards)</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-3 rounded-control bg-lemon/60 p-3">
          <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} className="size-5 accent-ink" />
          <span className="flex flex-col">
            <span className="text-sm font-bold">This is a test or exam</span>
            <span className="text-xs text-ink-2">Highlights the day and starts the countdown on Home</span>
          </span>
        </label>

        {!isTest && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-bold">How long?</legend>
            <div className="flex flex-wrap gap-2">
              {CHIPS.map((c) => {
                const on = !custom && Number(minutes) === c;
                return (
                  <button
                    type="button"
                    key={c}
                    aria-pressed={on}
                    onClick={() => { setCustom(false); setMinutes(c); }}
                    className={`h-9 rounded-full px-4 text-sm font-medium transition-colors ${on ? "bg-ink text-white" : "bg-sunken hover:bg-line"}`}
                  >
                    {c} min
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={custom}
                onClick={() => setCustom(true)}
                className={`h-9 rounded-full px-4 text-sm font-medium transition-colors ${custom ? "bg-ink text-white" : "bg-sunken hover:bg-line"}`}
              >
                Custom
              </button>
            </div>
            {custom && (
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="number" min={5} max={600} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={`${FIELD} w-28`} />
                minutes
              </label>
            )}
          </fieldset>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Notes <span className="font-normal text-ink-2">(optional)</span></span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What to focus on" className={FIELD} />
        </label>

        <div className="flex items-center gap-3 pt-1">
          {session && (
            <Button variant="danger" onClick={() => onDelete(session.id)}>
              <TrashIcon width={16} height={16} /> Delete
            </Button>
          )}
          <Button type="submit" className="ml-auto">{session ? "Save" : "Add session"}</Button>
        </div>
      </form>
    </dialog>
  );
}
