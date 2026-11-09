import { useEffect, useState } from "react";

// useState that survives a page reload. The API has no deck or plan storage
// yet, so decks and study sessions live in this browser only.
export function useStoredState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode or full storage: keep working in memory
    }
  }, [key, value]);

  return [value, setValue];
}
