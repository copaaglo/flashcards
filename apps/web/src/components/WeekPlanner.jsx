import { useState } from "react";
import { dateKey, formatMinutes, studyMinutes, weekDays, weekLabel } from "../lib/dates.js";
import { themeOf } from "../lib/themes.js";
import { CheckIcon, ChevronLeft, ChevronRight, CopyIcon, PlusIcon, PrintIcon, ResetIcon } from "./Icons.jsx";
import { Button, IconButton } from "./ui.jsx";

const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short" });

// `full` adds the toolbar (copy, print, reset) used on the Planner page.
// `rolling` shows the next 7 days from today instead of a Monday-to-Sunday week (Home).
export default function WeekPlanner({
  weekStart, sessions, decks, isThisWeek, full = false, rolling = false,
  onPrev, onNext, onToday, onAdd, onEdit, onMove, onToggleDone, onStudy, onCopy, onReset, copied,
}) {
  const [drag, setDrag] = useState(null); // { fromKey, id }
  const [target, setTarget] = useState(null); // { key, index }

  const todayKey = dateKey(new Date());
  const days = rolling ? weekDays(new Date()) : weekDays(weekStart);
  const weekTotal = days.reduce((sum, d) => sum + studyMinutes(sessions[dateKey(d)]), 0);
  const deckById = Object.fromEntries(decks.map((d) => [d.id, d]));

  function dragOver(e, key) {
    if (!drag) return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll("[data-session]")];
    let index = items.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (index === -1) index = items.length;
    if (target?.key !== key || target?.index !== index) setTarget({ key, index });
  }

  function drop(e, key) {
    e.preventDefault();
    if (drag && target) onMove(drag.fromKey, drag.id, key, target.index);
    setDrag(null);
    setTarget(null);
  }

  const dropLine = <div className="h-1 rounded-full bg-ink" aria-hidden="true" />;

  return (
    <section aria-labelledby="week-h" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="week-h" className="text-h2 font-extrabold tracking-tight">
            {rolling ? "Next 7 days" : isThisWeek ? "This week" : weekLabel(weekStart)}
          </h2>
          <span className="text-ink-2">
            {!rolling && isThisWeek && `${weekLabel(weekStart)}, `}
            {weekTotal ? `${formatMinutes(weekTotal)} planned` : "nothing planned yet"}
          </span>
        </div>
        <div className="no-print flex flex-wrap items-center gap-1">
          {full && (
            <>
              <Button variant="ghost" size="sm" onClick={onCopy}><CopyIcon width={16} height={16} />{copied ? "Copied" : "Copy"}</Button>
              <Button variant="ghost" size="sm" onClick={() => window.print()}><PrintIcon width={16} height={16} />Print</Button>
              <Button variant="ghost" size="sm" onClick={onReset} disabled={!weekTotal && !days.some((d) => sessions[dateKey(d)]?.length)}>
                <ResetIcon width={16} height={16} />Clear week
              </Button>
              <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
            </>
          )}
          {rolling ? (
            <a href="#/planner" className="text-sm font-bold text-ink underline-offset-4 hover:underline">Open planner</a>
          ) : (
            <>
              <IconButton label="Previous week" onClick={onPrev}><ChevronLeft /></IconButton>
              <Button variant="outline" size="sm" onClick={onToday} disabled={isThisWeek}>Today</Button>
              <IconButton label="Next week" onClick={onNext}><ChevronRight /></IconButton>
            </>
          )}
        </div>
      </div>

      {/* A stacked list on phones, 7 columns (scrolling sideways if needed) from tablets up */}
      <div className="md:-mx-6 md:overflow-x-auto md:px-6 md:pb-2 lg:mx-0 lg:px-0">
        <div className="grid grid-cols-1 gap-2.5 md:min-w-224 md:grid-cols-7">
          {days.map((day) => {
            const key = dateKey(day);
            const list = sessions[key] || [];
            const isToday = key === todayKey;
            const test = list.find((s) => s.isTest);
            const mins = studyMinutes(list);
            return (
              <div
                key={key}
                onDragOver={(e) => dragOver(e, key)}
                onDrop={(e) => drop(e, key)}
                className={`group flex flex-col md:min-h-44 gap-2.5 rounded-tile p-3.5 transition-colors ${
                  isToday ? "bg-ink text-white" : test ? "bg-lemon" : "border border-line bg-white"
                } ${target?.key === key ? "ring-2 ring-ink ring-offset-2" : ""}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className={`text-xs font-bold ${isToday || test ? "" : "text-ink-2"}`}>
                    {isToday ? "Today, " : ""}{dayName.format(day)} {day.getDate()}
                  </span>
                  <span className={`text-xs ${isToday ? "text-white/75" : "text-ink-2"}`}>{mins ? formatMinutes(mins) : ""}</span>
                </div>

                <div className="flex flex-1 flex-col gap-2">
                  {list.map((s, idx) => {
                    const deck = deckById[s.deckId];
                    const canStudy = deck?.status === "done" && deck.cards.length > 0;
                    const color = s.isTest
                      ? "bg-white/60 text-ink"
                      : deck
                        ? `${themeOf(deck).bg} ${themeOf(deck).text}`
                        : isToday ? "bg-white/15 text-white" : "bg-sunken text-ink";
                    return (
                      <div key={s.id} className="flex flex-col gap-2">
                        {target?.key === key && target.index === idx && dropLine}
                        <article
                          data-session
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", s.title);
                            setDrag({ fromKey: key, id: s.id });
                          }}
                          onDragEnd={() => { setDrag(null); setTarget(null); }}
                          className={`flex flex-col gap-1 rounded-control p-2 text-xs ${color} ${drag?.id === s.id ? "opacity-40" : ""}`}
                        >
                          <div className="flex items-start gap-2">
                            {!s.isTest && (
                              <button
                                type="button"
                                aria-label={s.done ? `Mark ${s.title} not done` : `Mark ${s.title} done`}
                                aria-pressed={s.done}
                                onClick={() => onToggleDone(key, s.id)}
                                className={`mt-px grid size-4.5 shrink-0 place-items-center rounded-full border-[1.5px] border-current`}
                              >
                                {s.done && <CheckIcon width={10} height={10} />}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onEdit(key, s)}
                              className={`min-w-0 flex-1 text-left font-medium break-words hover:underline ${s.done ? "line-through opacity-70" : ""} ${s.isTest ? "font-display text-base font-extrabold" : ""}`}
                            >
                              {s.title}
                            </button>
                          </div>
                          <div className={`flex items-center justify-between gap-1 ${s.isTest ? "" : "pl-6.5"}`}>
                            <span className="opacity-80">{s.isTest ? "Test" : formatMinutes(s.minutes)}</span>
                            {canStudy && !s.isTest && (
                              <button type="button" onClick={() => onStudy(deck)} className="font-bold underline-offset-2 hover:underline">
                                Study
                              </button>
                            )}
                          </div>
                        </article>
                      </div>
                    );
                  })}
                  {target?.key === key && target.index === list.length && dropLine}
                </div>

                <button
                  type="button"
                  onClick={() => onAdd(key)}
                  aria-label={`Add session on ${dayName.format(day)} ${day.getDate()}`}
                  className={`no-print flex h-9 items-center justify-center gap-1 rounded-control border-[1.5px] border-dashed text-xs font-medium transition-colors ${
                    isToday ? "border-white/30 text-white/80 hover:border-white" : "border-ink/20 text-ink-2 hover:border-ink hover:text-ink"
                  } ${list.length ? "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : ""}`}
                >
                  <PlusIcon width={14} height={14} /> Add
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
