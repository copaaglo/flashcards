import { useEffect, useState } from "react";
import { nextTheme } from "./themes.js";
import { useStoredState } from "./useStoredState.js";

const PENDING = new Set(["queued", "processing"]);
const MAX_BYTES = 20 * 1024 * 1024; // same limit the API enforces

export const isPending = (deck) => PENDING.has(deck.status);

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
    // Check what we can before uploading, so the user gets the answer instantly
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setUploadError({ title: "That isn't a PDF", detail: `${file.name} isn't a PDF. Export your notes or slides as a PDF and try again.` });
      return false;
    }
    if (file.size > MAX_BYTES) {
      const mb = Math.round(file.size / 1024 / 1024);
      setUploadError({ title: "That file is too big", detail: `${file.name} is ${mb} MB. The limit is 20 MB, so try exporting it without images.` });
      return false;
    }
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
        { id: job_id, name, status, summary: null, error: null, cards: [], createdAt: Date.now(), theme: nextTheme(all) },
        ...all,
      ]);
      return true;
    } catch (err) {
      const offline = err instanceof TypeError; // fetch throws TypeError when the network is down
      setUploadError({
        title: offline ? "Can't reach the server" : "Upload failed",
        detail: offline ? "Check your connection and try again." : err.message,
      });
      return false;
    } finally {
      setUploading(false);
    }
  }

  // Returns what restoreDeck needs to undo the removal
  function removeDeck(id) {
    const index = decks.findIndex((d) => d.id === id);
    if (index === -1) return null;
    const deck = decks[index];
    setDecks((all) => all.filter((d) => d.id !== id));
    return { deck, index };
  }

  function restoreDeck({ deck, index }) {
    setDecks((all) => (all.some((d) => d.id === deck.id) ? all : [...all.slice(0, index), deck, ...all.slice(index)]));
  }

  return { decks, upload, uploading, uploadError, clearUploadError: () => setUploadError(null), removeDeck, restoreDeck };
}
