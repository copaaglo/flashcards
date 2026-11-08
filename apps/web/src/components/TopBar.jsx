import { useRef } from "react";
import { LogoIcon, UploadIcon } from "./Icons.jsx";

export default function TopBar({ onUpload, uploading }) {
  const input = useRef(null);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark"><LogoIcon /></span>
          <span className="brand-name">Flashcards</span>
          <span className="brand-tag">Study planner</span>
        </div>
        <button className="btn btn-primary" onClick={() => input.current.click()} disabled={uploading}>
          <UploadIcon />
          <span>{uploading ? "Uploading…" : "Upload lecture"}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files[0];
            e.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>
    </header>
  );
}
