import { useState } from "react";
import { PlayIcon, TrashIcon, UploadIcon } from "./Icons.jsx";

const STATUS_LABEL = { queued: "Queued", processing: "Generating…", done: "Ready", failed: "Failed" };

export default function DeckShelf({ decks, onUpload, uploading, uploadError, onStudy, onRemove }) {
  const [dragging, setDragging] = useState(false);

  function drop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onUpload(file);
  }

  return (
    <section className="shelf" aria-label="Your decks">
      <div className="section-head">
        <h2>Your decks</h2>
        <span className="muted">{decks.length ? `${decks.length} total` : "Upload a lecture PDF to get started"}</span>
      </div>

      <div className="shelf-row">
        <label
          className={`deck deck-drop${dragging ? " is-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <input
            type="file"
            accept="application/pdf"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <span className="deck-drop-icon"><UploadIcon /></span>
          <strong>{uploading ? "Uploading…" : "Drop a PDF"}</strong>
          <span className="muted small">or click to browse · max 20 MB</span>
        </label>

        {decks.map((deck) => (
          <article key={deck.id} className={`deck deck-${deck.status}`}>
            <div className="deck-top">
              <span className={`pill pill-${deck.status}`}>
                {(deck.status === "queued" || deck.status === "processing") && <span className="spinner" />}
                {STATUS_LABEL[deck.status] ?? deck.status}
              </span>
              <button className="icon-btn" title="Remove deck" onClick={() => onRemove(deck.id)}>
                <TrashIcon />
              </button>
            </div>
            <h3 className="deck-name" title={deck.name}>{deck.name}</h3>
            {deck.status === "failed" ? (
              <p className="deck-error small">{deck.error || "Something went wrong"}</p>
            ) : (
              <p className="muted small deck-summary">
                {deck.summary || (deck.status === "done" ? "No summary" : "Reading your lecture…")}
              </p>
            )}
            <div className="deck-foot">
              <span className="muted small">{deck.cards.length} cards</span>
              <button
                className="btn btn-soft btn-sm"
                disabled={deck.status !== "done" || !deck.cards.length}
                onClick={() => onStudy(deck)}
              >
                <PlayIcon /> Study
              </button>
            </div>
          </article>
        ))}
      </div>

      {uploadError && <p className="alert" role="alert">{uploadError}</p>}
    </section>
  );
}
