import { useRef } from "react";
import { PlusIcon } from "./Icons.jsx";
import { Button } from "./ui.jsx";

const NAV = [
  { route: "home", href: "#/", label: "Home" },
  { route: "decks", href: "#/decks", label: "Decks" },
  { route: "planner", href: "#/planner", label: "Planner" },
];

export default function AppHeader({ route, onUpload, uploading }) {
  const input = useRef(null);

  return (
    <header className="no-print mx-auto flex max-w-310 flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
      <a href="#/" className="font-display text-title font-extrabold tracking-tight text-ink no-underline">
        cramcards
      </a>
      <nav aria-label="Main" className="order-last flex w-full gap-1 sm:order-none sm:w-auto">
        {NAV.map((n) => (
          <a
            key={n.route}
            href={n.href}
            aria-current={route === n.route ? "page" : undefined}
            className={`rounded-full px-3.5 py-2 text-sm font-medium no-underline transition-colors ${
              route === n.route ? "bg-ink text-white" : "text-ink hover:bg-ink/5"
            }`}
          >
            {n.label}
          </a>
        ))}
      </nav>
      <Button variant="outline" onClick={() => input.current.click()} disabled={uploading}>
        <PlusIcon width={16} height={16} />
        {uploading ? "Uploading..." : "Upload lecture"}
      </Button>
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
    </header>
  );
}
