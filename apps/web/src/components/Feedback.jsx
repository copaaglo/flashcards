import { useEffect } from "react";
import { AlertIcon, CloseIcon } from "./Icons.jsx";
import { IconButton } from "./ui.jsx";

// Says what happened and what to do about it
export function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-card border border-danger/25 bg-danger-soft p-4 text-danger">
      <AlertIcon className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-bold">{error.title}</span>
        <span className="text-sm break-words">{error.detail}</span>
      </div>
      <IconButton label="Dismiss" onClick={onDismiss} className="-my-2 -mr-2 hover:bg-danger/10">
        <CloseIcon width={16} height={16} />
      </IconButton>
    </div>
  );
}

// Bottom toast with an optional action (Undo). Replaces confirm() popups.
export function Toast({ toast, onDone }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [toast, onDone]);

  if (!toast) return null;
  return (
    <div className="no-print fixed inset-x-0 bottom-6 z-50 flex justify-center px-4" role="status">
      <div className="flex items-center gap-4 rounded-tile bg-ink py-2 pr-2 pl-4 text-white shadow-overlay">
        <span className="text-sm">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => { toast.action.run(); onDone(); }}
            className="h-9 rounded-control px-3 text-sm font-bold text-lemon hover:bg-white/10"
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
