// The few building blocks every screen uses. Variants live here, so a button
// can't be styled ad hoc somewhere else and drift from the design.

const BUTTON = {
  base: "inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
  primary: "bg-ink text-white hover:bg-ink/85",
  outline: "border-[1.5px] border-current bg-transparent hover:bg-ink/5",
  ghost: "bg-transparent hover:bg-ink/5",
  danger: "border-[1.5px] border-line bg-white text-danger hover:bg-danger-soft",
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-7 text-base",
};

export function Button({ variant = "primary", size = "md", className = "", type = "button", ...props }) {
  return <button type={type} className={`${BUTTON.base} ${BUTTON[variant]} ${BUTTON[size]} ${className}`} {...props} />;
}

export function IconButton({ label, className = "", children, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-grid size-11 shrink-0 place-items-center rounded-control transition-colors hover:bg-ink/5 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Chip({ className = "bg-sunken", children }) {
  return (
    <span className={`inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, max, label, track = "bg-ink/15", bar = "bg-ink", className = "" }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={`h-2 overflow-hidden rounded-full ${track} ${className}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${bar}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SectionHeader({ id, title, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h2 id={id} className="text-h2 font-extrabold tracking-tight">{title}</h2>
      {children}
    </div>
  );
}
