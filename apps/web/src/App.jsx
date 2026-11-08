import { useCallback, useState } from "react";
import DeckShelf from "./components/DeckShelf.jsx";
import QuickAddSheet from "./components/QuickAddSheet.jsx";
import StudyModal from "./components/StudyModal.jsx";
import TopBar from "./components/TopBar.jsx";
import WeekPlanner from "./components/WeekPlanner.jsx";
import { addDays, dateKey, formatMinutes, startOfWeek, studyMinutes, weekDays, weekLabel } from "./lib/dates.js";
import { useDecks } from "./lib/useDecks.js";
import { useStoredState } from "./lib/useStoredState.js";

export default function App() {
  const { decks, upload, uploading, uploadError, removeDeck } = useDecks();
  // { "YYYY-MM-DD": [session, ...] } in display order
  const [sessions, setSessions] = useStoredState("flashcards.sessions", {});
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [sheet, setSheet] = useState(null); // { key, session, n }
  const [studying, setStudying] = useState(null);
  const [copied, setCopied] = useState(false);

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeStudy = useCallback(() => setStudying(null), []);
  const isThisWeek = dateKey(weekStart) === dateKey(startOfWeek(new Date()));

  function updateDay(key, fn) {
    setSessions((all) => {
      const next = { ...all, [key]: fn(all[key] || []) };
      if (!next[key].length) delete next[key];
      return next;
    });
  }

  function save(session) {
    const { key } = sheet;
    updateDay(key, (list) =>
      list.some((s) => s.id === session.id)
        ? list.map((s) => (s.id === session.id ? session : s))
        : [...list, session],
    );
    setSheet(null);
  }

  function remove(id) {
    updateDay(sheet.key, (list) => list.filter((s) => s.id !== id));
    setSheet(null);
  }

  function move(fromKey, id, toKey, toIndex) {
    setSessions((all) => {
      const from = [...(all[fromKey] || [])];
      const at = from.findIndex((s) => s.id === id);
      if (at === -1) return all;
      const [item] = from.splice(at, 1);
      const next = { ...all, [fromKey]: from };
      const to = fromKey === toKey ? from : [...(all[toKey] || [])];
      to.splice(fromKey === toKey && at < toIndex ? toIndex - 1 : toIndex, 0, item);
      next[toKey] = to;
      for (const k of [fromKey, toKey]) if (!next[k].length) delete next[k];
      return next;
    });
  }

  function toggleDone(key, id) {
    updateDay(key, (list) => list.map((s) => (s.id === id ? { ...s, done: !s.done } : s)));
  }

  function removeDeckEverywhere(id) {
    removeDeck(id);
    setSessions((all) =>
      Object.fromEntries(
        Object.entries(all).map(([k, list]) => [k, list.map((s) => (s.deckId === id ? { ...s, deckId: null } : s))]),
      ),
    );
  }

  async function copyWeek() {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
    const lines = [`Study plan · ${weekLabel(weekStart)}`, ""];
    for (const day of weekDays(weekStart)) {
      const list = sessions[dateKey(day)] || [];
      lines.push(`${fmt.format(day)}${list.length ? ` (${formatMinutes(studyMinutes(list))})` : ""}`);
      if (!list.length) lines.push("  —");
      for (const s of list) lines.push(`  ${s.done ? "✓" : "•"} ${s.title} — ${s.isTest ? "TEST" : formatMinutes(s.minutes)}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert("Couldn't access the clipboard");
    }
  }

  function resetWeek() {
    if (!confirm(`Clear every session for ${weekLabel(weekStart)}?`)) return;
    const keys = new Set(weekDays(weekStart).map(dateKey));
    setSessions((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !keys.has(k))));
  }

  return (
    <>
      <TopBar onUpload={upload} uploading={uploading} />
      <main className="page">
        <DeckShelf
          decks={decks}
          onUpload={upload}
          uploading={uploading}
          uploadError={uploadError}
          onStudy={setStudying}
          onRemove={removeDeckEverywhere}
        />
        <WeekPlanner
          weekStart={weekStart}
          sessions={sessions}
          decks={decks}
          isThisWeek={isThisWeek}
          onPrev={() => setWeekStart((w) => addDays(w, -7))}
          onNext={() => setWeekStart((w) => addDays(w, 7))}
          onToday={() => setWeekStart(startOfWeek(new Date()))}
          onAdd={(key) => setSheet({ key, session: null, n: Date.now() })}
          onEdit={(key, session) => setSheet({ key, session, n: Date.now() })}
          onMove={move}
          onToggleDone={toggleDone}
          onStudy={setStudying}
          onCopy={copyWeek}
          onReset={resetWeek}
          copied={copied}
        />
      </main>

      {sheet && (
        <QuickAddSheet
          key={sheet.n}
          dayKey={sheet.key}
          session={sheet.session}
          decks={decks}
          onSave={save}
          onDelete={remove}
          onClose={closeSheet}
        />
      )}
      {studying && <StudyModal deck={studying} onClose={closeStudy} />}
    </>
  );
}
