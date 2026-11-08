import { useState } from "react";
import { PlusIcon, SpinnerIcon } from "./Icons.jsx";

// The drop zone. `large` is the first-visit version that fills the hero.
export default function UploadTile({ onUpload, uploading, large = false }) {
  const [over, setOver] = useState(false);

  function drop(e) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file && !uploading) onUpload(file);
  }

  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={`flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed p-6 text-center transition-colors focus-within:outline-[2.5px] focus-within:outline-offset-2 focus-within:outline-ink ${
        over ? "border-ink bg-sunken" : "border-line hover:border-ink-2"
      } ${uploading ? "cursor-wait" : "cursor-pointer"} ${large ? "min-h-75 bg-white" : "min-h-56"}`}
    >
      <input
        type="file"
        accept="application/pdf"
        className="sr-only"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files[0];
          e.target.value = "";
          if (file) onUpload(file);
        }}
      />
      <span className={`grid place-items-center rounded-full bg-ink text-white ${large ? "size-14" : "size-12"}`}>
        {uploading ? <SpinnerIcon width={20} height={20} /> : <PlusIcon width={20} height={20} />}
      </span>
      {large ? (
        <>
          <span className="mt-2 font-display text-title font-semibold">Upload your first lecture</span>
          <span className="max-w-80 text-ink-2">
            Drop a PDF here or click to browse. You'll get a summary and a quiz deck in about a minute.
          </span>
          <span className="text-xs text-ink-2">PDF with selectable text, up to 20 MB</span>
        </>
      ) : (
        <>
          <span className="font-bold">{uploading ? "Uploading..." : "Drop a lecture PDF"}</span>
          <span className="text-xs text-ink-2">Cards in about a minute</span>
        </>
      )}
    </label>
  );
}
