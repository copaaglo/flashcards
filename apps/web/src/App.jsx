import { useCallback, useEffect, useState } from "react";
import AppHeader from "./components/AppHeader.jsx";
import DeckTile from "./components/DeckTile.jsx";
import { ErrorBanner, Toast } from "./components/Feedback.jsx";
import Hero from "./components/Hero.jsx";
import ResultsView from "./components/ResultsView.jsx";
import SessionDialog from "./components/SessionDialog.jsx";
import StudyView from "./components/StudyView.jsx";
import { SectionHeader } from "./components/ui.jsx";
import UploadTile from "./components/UploadTile.jsx";
import WeekPlanner from "./components/WeekPlanner.jsx";
import { addDays, dateKey, formatMinutes, nextTest, startOfWeek, studyMinutes, weekDays, weekLabel } from "./lib/dates.js";
import { addStudyDay, deckStats, recordAnswer, shakyIndices, streak } from "./lib/progress.js";
import { shuffle } from "./lib/quiz.js";
import { useDecks } from "./lib/useDecks.js";
import { useStoredState } from "./lib/useStoredState.js";

const HOME_DECKS = 5;

function readRoute() {
  const r = window.location.hash.replace(/^#\/?/, "");
  return ["decks", "planner"].includes(r) ? r : "home";
}

function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

const isReady = (d) => d.status === "done" && d.cards.length > 0;

export default function App() {
  const route = useRoute();
  const { decks, upload, uploading, uploadError, clearUploadError, removeDeck, restoreDeck } = useDecks();
  // { "YYYY-MM-DD": [session, ...] } in display order
  const [sessions, setSessions] = useStoredState("flashcards.sessions", {});
  const [progress, setProgress] = useStoredState("flashcards.progress", {});
  const [studyDays, setStudyDays] = useStoredState("flashcards.studyDays", []);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [sheet, setSheet] = useState(null); // { key, session, n }
  const [study, setStudy] = useState(null); // { deckId, order }
  const [results, setResults] = useState(null); // { deckId, answers, ms }
  const [toast, setToast] = useState(null);
  const [copied, setCopied] = useState(false);

  const closeSheet = useCallback(() => setSheet(null), []);
  const clearToast = useCallback(() => setToast(null), []);

  const today = new Date();
  const todayKey = dateKey(today);
  const isThisWeek = dateKey(weekStart) === dateKey(startOfWeek(today));
  const streakDays = streak(studyDays, today);
  const readyDecks = decks.filter(isReady);

  // ---------- Study ----------
  function startStudy(deck, indices) {
    const all = deck.cards.map((_, i) => i);
    setResults(null);
    setStudy({ deckId: deck.id, order: shuffle(indices?.length ? indices : all) });
  }

  function answer(deckId, cardIndex, correct) {
    setProgress((p) => recordAnswer(p, deckId, cardIndex, correct));
    setStudyDays((days) => addStudyDay(days, dateKey(new Date())));
  }

  function finishStudy(result) {
    setResults({ deckId: study.deckId, ...result });
    setStudy(null);
  }

  // ---------- Decks ----------
  async function handleUpload(file) {
    if (await upload(file)) {
      setToast({ message: `Uploaded ${file.name}. Making your cards now.` });
    }
  }

  function handleRemove(id) {
    const removed = removeDeck(id);
    if (removed) setToast({ message: `Removed ${removed.deck.name}`, action: { label: "Undo", run: () => restoreDeck(removed) } });
  }

  // ---------- Planner ----------
  function updateDay(key, fn) {
    setSessions((all) => {
      const next = { ...all, [key]: fn(all[key] || []) };
      if (!next[key].length) delete next[key];
      return next;
    });
  }

  function saveSession(session) {
    updateDay(sheet.key, (list) =>
      list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? session : s)) : [...list, session],
    );
    setSheet(null);
  }

  function deleteSession(id) {
    const before = sessions;
    updateDay(sheet.key, (list) => list.filter((s) => s.id !== id));
    setSheet(null);
    setToast({ message: "Session deleted", action: { label: "Undo", run: () => setSessions(before) } });
  }

  function moveSession(fromKey, id, toKey, toIndex) {
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

  async function copyWeek() {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
    const lines = [`Study plan, ${weekLabel(weekStart)}`, ""];
    for (const day of weekDays(weekStart)) {
      const list = sessions[dateKey(day)] || [];
      lines.push(`${fmt.format(day)}${list.length ? ` (${formatMinutes(studyMinutes(list))})` : ""}`);
      if (!list.length) lines.push("  (free)");
      for (const s of list) lines.push(`  ${s.done ? "[x]" : "[ ]"} ${s.title}: ${s.isTest ? "TEST" : formatMinutes(s.minutes)}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setToast({ message: "Couldn't access the clipboard" });
    }
  }

  function clearWeek() {
    const before = sessions;
    const keys = new Set(weekDays(weekStart).map(dateKey));
    setSessions((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !keys.has(k))));
    setToast({ message: `Cleared ${weekLabel(weekStart)}`, action: { label: "Undo", run: () => setSessions(before) } });
  }

  // ---------- Home: what to study next ----------
  const todaysSessions = sessions[todayKey] || [];
  const plannedToday = studyMinutes(todaysSessions.filter((s) => !s.done));
  const deckById = Object.fromEntries(decks.map((d) => [d.id, d]));
  const plannedSession = todaysSessions.find((s) => !s.done && !s.isTest && deckById[s.deckId] && isReady(deckById[s.deckId]));
  const mostShaky = [...readyDecks].sort((a, b) => shakyIndices(b, progress).length - shakyIndices(a, progress).length)[0];
  const upNextDeck = plannedSession ? deckById[plannedSession.deckId] : mostShaky;
  const upNext = upNextDeck && {
    deck: upNextDeck,
    stats: deckStats(upNextDeck, progress),
    shaky: shakyIndices(upNextDeck, progress),
    session: plannedSession,
  };
  const totalShaky = readyDecks.reduce((sum, d) => sum + shakyIndices(d, progress).length, 0);

  const plannerProps = {
    weekStart, sessions, decks, isThisWeek, copied,
    onPrev: () => setWeekStart((w) => addDays(w, -7)),
    onNext: () => setWeekStart((w) => addDays(w, 7)),
    onToday: () => setWeekStart(startOfWeek(new Date())),
    onAdd: (key) => setSheet({ key, session: null, n: Date.now() }),
    onEdit: (key, session) => setSheet({ key, session, n: Date.now() }),
    onMove: moveSession,
    onToggleDone: toggleDone,
    onStudy: (deck) => startStudy(deck),
    onCopy: copyWeek,
    onReset: clearWeek,
  };

  const deckGrid = (list, showUpload) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
      {list.map((d) => (
        <DeckTile key={d.id} deck={d} progress={progress} onStudy={(deck) => startStudy(deck)} onRemove={handleRemove} />
      ))}
      {showUpload && <UploadTile onUpload={handleUpload} uploading={uploading} />}
    </div>
  );

  const studyDeck = study && deckById[study.deckId];
  const resultsDeck = results && deckById[results.deckId];
  const overlayOpen = Boolean(studyDeck || resultsDeck);

  // Stop the page behind a full-screen view from scrolling
  useEffect(() => {
    document.body.style.overflow = overlayOpen ? "hidden" : "";
  }, [overlayOpen]);

  return (
    <>
      <div inert={overlayOpen}>
        <AppHeader route={route} onUpload={handleUpload} uploading={uploading} />

        <main className="mx-auto flex max-w-310 flex-col gap-12 px-4 pt-4 pb-16 sm:px-6">
          {uploadError && <ErrorBanner error={uploadError} onDismiss={clearUploadError} />}

          {route === "home" && (
            <>
              <Hero
                test={nextTest(sessions, todayKey)}
                streakDays={streakDays}
                plannedToday={plannedToday}
                upNext={upNext}
                totalShaky={totalShaky}
                readyCount={readyDecks.length}
                hasDecks={decks.length > 0}
                onStart={startStudy}
                onUpload={handleUpload}
                uploading={uploading}
              />
              {decks.length > 0 && (
                <section aria-labelledby="decks-h" className="flex flex-col gap-5">
                  <SectionHeader id="decks-h" title="Your decks">
                    {decks.length > HOME_DECKS && (
                      <a href="#/decks" className="text-sm font-bold text-ink underline-offset-4 hover:underline">
                        See all {decks.length}
                      </a>
                    )}
                  </SectionHeader>
                  {deckGrid(decks.slice(0, HOME_DECKS), true)}
                </section>
              )}
              <WeekPlanner {...plannerProps} rolling />
            </>
          )}

          {route === "decks" && (
            <section aria-labelledby="decks-h" className="flex flex-col gap-5">
              <SectionHeader id="decks-h" title="All decks">
                <span className="text-ink-2">
                  {decks.length} {decks.length === 1 ? "deck" : "decks"}, {readyDecks.reduce((n, d) => n + d.cards.length, 0)} cards
                </span>
              </SectionHeader>
              {decks.length ? deckGrid(decks, true) : <UploadTile onUpload={handleUpload} uploading={uploading} large />}
            </section>
          )}

          {route === "planner" && <WeekPlanner {...plannerProps} full />}
        </main>
      </div>

      {sheet && (
        <SessionDialog
          key={sheet.n}
          dayKey={sheet.key}
          session={sheet.session}
          decks={decks}
          onSave={saveSession}
          onDelete={deleteSession}
          onClose={closeSheet}
        />
      )}

      {studyDeck && (
        <StudyView
          key={`${study.deckId}-${study.order.join(",")}`}
          deck={studyDeck}
          order={study.order}
          onAnswer={(i, correct) => answer(study.deckId, i, correct)}
          onFinish={finishStudy}
          onClose={() => setStudy(null)}
        />
      )}

      {resultsDeck && !studyDeck && (
        <ResultsView
          deck={resultsDeck}
          result={results}
          streakDays={streakDays}
          onRedo={(indices) => startStudy(resultsDeck, indices)}
          onClose={() => setResults(null)}
        />
      )}

      <Toast toast={toast} onDone={clearToast} />
    </>
  );
}
