import { useState } from "react";
import { dateKey, formatMinutes, studyMinutes, weekDays, weekLabel } from "../lib/dates.js";
import {
  CheckIcon, ChevronLeft, ChevronRight, CopyIcon, PlayIcon, PlusIcon, PrintIcon, ResetIcon,
} from "./Icons.jsx";

const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export default function WeekPlanner({
  weekStart, sessions, decks, onPrev, onNext, onToday, isThisWeek,
  onAdd, onEdit, onMove, onToggleDone, onStudy, onCopy, onReset, copied,
}) {
  const [drag, setDrag] = useState(null); // { fromKey, id }
  const [target, setTarget] = useState(null); // { key, index }

  const days = weekDays(weekStart);
  const todayKey = dateKey(new Date());
  const totals = days.map((d) => studyMinutes(sessions[dateKey(d)]));
  const weekTotal = totals.reduce((a, b) => a + b, 0);
  const scale = Math.max(120, ...totals); // bar is full at 2h or the busiest day
  const deckById = Object.fromEntries(decks.map((d) => [d.id, d]));

  function dragOver(e, key) {
    if (!drag) return;
    e.preventDefault();
    const cards = [...e.currentTarget.querySelectorAll("[data-session]")];
    let index = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (index === -1) index = cards.length;
    if (target?.key !== key || target?.index !== index) setTarget({ key, index });
  }

  function drop(e, key) {
    e.preventDefault();
    if (drag && target) onMove(drag.fromKey, drag.id, key, target.index);
    setDrag(null);
    setTarget(null);
  }

  return (
    <section className="planner" aria-label="Weekly plan">
      <div className="planner-head">
        <div className="week-nav">
          <button className="icon-btn" onClick={onPrev} aria-label="Previous week"><ChevronLeft /></button>
          <h2>{weekLabel(weekStart)}</h2>
          <button className="icon-btn" onClick={onNext} aria-label="Next week"><ChevronRight /></button>
          {!isThisWeek && <button className="btn btn-ghost btn-sm" onClick={onToday}>Today</button>}
        </div>
        <div className="toolbar">
          <span className="week-total">
            <strong>{formatMinutes(weekTotal)}</strong> <span className="muted">studying this week</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onCopy}><CopyIcon />{copied ? "Copied!" : "Copy"}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}><PrintIcon />Print</button>
          <button className="btn btn-ghost btn-sm" onClick={onReset}><ResetIcon />Reset</button>
        </div>
      </div>

      <div className="week-grid">
        {days.map((day, i) => {
          const key = dateKey(day);
          const list = sessions[key] || [];
          const hasTest = list.some((s) => s.isTest);
          return (
            <div
              key={key}
              className={`day${key === todayKey ? " is-today" : ""}${target?.key === key ? " is-target" : ""}`}
              onClick={() => onAdd(key)}
              onDragOver={(e) => dragOver(e, key)}
              onDrop={(e) => drop(e, key)}
            >
              <div className="day-head">
                <div>
                  <span className="day-name">{dayName.format(day)}</span>
                  <span className="day-date">{day.getDate()}</span>
                </div>
                {hasTest && <span className="test-dot" title="Test day">Test</span>}
                <button
                  className="icon-btn add-btn"
                  aria-label={`Add session on ${dayName.format(day)}`}
                  onClick={(e) => { e.stopPropagation(); onAdd(key); }}
                >
                  <PlusIcon />
                </button>
              </div>

              <div className="day-list">
                {list.map((s, idx) => {
                  const deck = deckById[s.deckId];
                  const canStudy = deck?.status === "done" && deck.cards.length > 0;
                  return (
                    <div key={s.id} className="slot">
                      {target?.key === key && target.index === idx && <div className="drop-line" />}
                      <article
                        data-session
                        draggable
                        className={`session${s.isTest ? " is-test" : ""}${s.done ? " is-done" : ""}${drag?.id === s.id ? " is-dragging" : ""}`}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", s.title);
                          setDrag({ fromKey: key, id: s.id });
                        }}
                        onDragEnd={() => { setDrag(null); setTarget(null); }}
                        onClick={(e) => { e.stopPropagation(); onEdit(key, s); }}
                      >
                        <div className="session-top">
                          <button
                            className={`check${s.done ? " on" : ""}`}
                            aria-label={s.done ? "Mark not done" : "Mark done"}
                            onClick={(e) => { e.stopPropagation(); onToggleDone(key, s.id); }}
                          >
                            {s.done && <CheckIcon />}
                          </button>
                          <span className="session-title">{s.title}</span>
                        </div>
                        {s.notes && <p className="session-notes">{s.notes}</p>}
                        <div className="session-foot">
                          <span className={`badge${s.isTest ? " badge-test" : ""}`}>
                            {s.isTest ? "Test" : formatMinutes(s.minutes)}
                          </span>
                          {deck && <span className="session-deck" title={deck.name}>{deck.name}</span>}
                          {canStudy && (
                            <button
                              className="icon-btn study-btn"
                              aria-label={`Study ${deck.name}`}
                              onClick={(e) => { e.stopPropagation(); onStudy(deck); }}
                            >
                              <PlayIcon />
                            </button>
                          )}
                        </div>
                      </article>
                    </div>
                  );
                })}
                {target?.key === key && target.index === list.length && <div className="drop-line" />}
                {!list.length && <p className="day-empty">Free day · click to plan</p>}
              </div>

              <div className="day-foot">
                <div className="load"><span style={{ width: `${(totals[i] / scale) * 100}%` }} /></div>
                <span>{totals[i] ? formatMinutes(totals[i]) : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
