import { useState } from "react";

export default function App() {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  async function upload(e) {
    e.preventDefault();
    setError(null);
    setJob(null);
    const form = new FormData();
    form.append("file", e.target.file.files[0]);

    const res = await fetch("/api/jobs", { method: "POST", body: form });
    if (!res.ok) return setError((await res.json()).detail);
    const { job_id } = await res.json();
    poll(job_id);
  }

  async function poll(jobId) {
    const res = await fetch(`/api/jobs/${jobId}`);
    const data = await res.json();
    setJob(data);
    if (data.status === "queued" || data.status === "processing") {
      setTimeout(() => poll(jobId), 2000);
    }
  }

  return (
    <main style={{ maxWidth: 700, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h1>Lecture to Flashcards (shipped by Argo CD)</h1>
      <form onSubmit={upload}>
        <input type="file" name="file" accept="application/pdf" required />
        <button type="submit">Upload</button>
      </form>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {job && <p>Status: <b>{job.status}</b></p>}
      {job?.error && <p style={{ color: "crimson" }}>{job.error}</p>}
      {job?.summary && <p>{job.summary}</p>}

      {job?.cards.map((card, i) => (
        <details key={i} style={{ border: "1px solid #ccc", padding: "0.75rem", margin: "0.5rem 0" }}>
          <summary>{card.question}</summary>
          <p>{card.answer}</p>
        </details>
      ))}
    </main>
  );
}