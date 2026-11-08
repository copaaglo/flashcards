// Each deck gets one color theme so it's recognizable everywhere it shows up.
// Class names are written out in full so Tailwind can find them when it scans the code.
export const THEMES = {
  tangerine: { bg: "bg-tangerine", text: "text-ink", soft: "bg-ink/15", bar: "bg-ink" },
  lilac: { bg: "bg-lilac", text: "text-ink", soft: "bg-ink/15", bar: "bg-ink" },
  mint: { bg: "bg-mint", text: "text-ink", soft: "bg-ink/15", bar: "bg-ink" },
  lemon: { bg: "bg-lemon", text: "text-ink", soft: "bg-ink/15", bar: "bg-ink" },
  cobalt: { bg: "bg-cobalt", text: "text-white", soft: "bg-white/25", bar: "bg-white" },
};

export const THEME_ORDER = ["tangerine", "lilac", "mint", "lemon", "cobalt"];

// Small, stable string hash, so a deck without a saved theme always gets the same one
function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function themeName(deck) {
  if (deck && THEMES[deck.theme]) return deck.theme;
  return THEME_ORDER[hash(deck?.id ?? "") % THEME_ORDER.length];
}

export const themeOf = (deck) => THEMES[themeName(deck)];

// The theme the fewest existing decks use, ties broken by THEME_ORDER
export function nextTheme(decks) {
  const counts = Object.fromEntries(THEME_ORDER.map((t) => [t, 0]));
  for (const d of decks) counts[themeName(d)]++;
  return THEME_ORDER.reduce((best, t) => (counts[t] < counts[best] ? t : best), THEME_ORDER[0]);
}
