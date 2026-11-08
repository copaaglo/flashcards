// Weeks start on Monday. Dates are keyed by local "YYYY-MM-DD" strings.

export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function dateKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function weekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  return `${short.format(weekStart)} to ${short.format(end)}`;
}

export function formatMinutes(total) {
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Tests don't count toward study time
export const studyMinutes = (list = []) =>
  list.filter((s) => !s.isTest).reduce((sum, s) => sum + s.minutes, 0);

export function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Whole days from one date key to another (negative if `to` is earlier)
export function daysBetween(fromKey, toKey) {
  return Math.round((parseKey(toKey) - parseKey(fromKey)) / 86_400_000);
}

// The next test (today or later) in the planner, or null
export function nextTest(sessions, todayKey) {
  const keys = Object.keys(sessions).filter((k) => k >= todayKey).sort();
  for (const key of keys) {
    const test = sessions[key].find((s) => s.isTest);
    if (test) return { key, title: test.title, days: daysBetween(todayKey, key) };
  }
  return null;
}
