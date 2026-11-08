import { useEffect, useState } from "react";
import { useStoredState } from "./useStoredState.js";

const PENDING = new Set(["queued", "processing"]);

// A deck is one uploaded PDF (one API job) and the cards generated from it.
export function useDecks() {
  const [decks, setDecks] = useStoredState("flashcards.decks", []);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const pendingIds = decks
    .filter((d) => PENDING.has(d.status))
    .map((d) => d.id)
    .join(",");

  // Poll every pending job until it is done or failed
  useEffect(() => {
    if (!pendingIds) return;
    const timer = setInterval(async () => {
      for (const id of pendingIds.split(",")) {
        let patch;
        try {
          const res = await fetch(`/api/jobs/${id}`);
          if (res.status === 404) patch = { status: "failed", error: "Job not found" };
          else if (!res.ok) continue;
          else {
            const job = await res.json();
            patch = { status: job.status, summary: job.summary, error: job.error, cards: job.cards };
          }
        } catch {
          continue; // network blip, try again next tick
        }
        setDecks((all) => all.map((d) => (d.id === id ? { ...d, ...patch } : d)));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingIds, setDecks]);

  async function upload(file) {
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/jobs", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Upload failed (${res.status})`);
      }
      const { job_id, status } = await res.json();
      const name = file.name.replace(/\.pdf$/i, "");
      setDecks((all) => [
        { id: job_id, name, status, summary: null, error: null, cards: [], createdAt: Date.now() },
        ...all,
      ]);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function removeDeck(id) {
    setDecks((all) => all.filter((d) => d.id !== id));
  }

  return { decks, upload, uploading, uploadError, removeDeck };
}
