// Small inline icons (stroke = currentColor) so we don't need an icon library
const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const LogoIcon = () => (
  <svg {...base} width={22} height={22}>
    <rect x="3" y="6" width="14" height="14" rx="2.5" />
    <path d="M7 3h11.5A2.5 2.5 0 0 1 21 5.5V17" />
  </svg>
);
export const ChevronLeft = () => <svg {...base}><path d="m15 18-6-6 6-6" /></svg>;
export const ChevronRight = () => <svg {...base}><path d="m9 18 6-6-6-6" /></svg>;
export const PlusIcon = () => <svg {...base}><path d="M12 5v14M5 12h14" /></svg>;
export const UploadIcon = () => (
  <svg {...base}><path d="M12 15V3M7 8l5-5 5 5M5 21h14" /></svg>
);
export const CopyIcon = () => (
  <svg {...base}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
);
export const PrintIcon = () => (
  <svg {...base}><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" /></svg>
);
export const ResetIcon = () => (
  <svg {...base}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
);
export const CloseIcon = () => <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const TrashIcon = () => (
  <svg {...base} width={16} height={16}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
);
export const PlayIcon = () => (
  <svg {...base} width={14} height={14}><path d="m6 4 14 8-14 8z" fill="currentColor" /></svg>
);
export const CheckIcon = () => (
  <svg {...base} width={12} height={12} strokeWidth={3}><path d="M20 6 9 17l-5-5" /></svg>
);
export const ShuffleIcon = () => (
  <svg {...base}><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
);
