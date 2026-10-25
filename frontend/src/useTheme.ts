import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

// Also read by the inline script in index.html, which applies the theme
// before first paint so a saved choice never flashes the other theme.
export const THEME_STORAGE_KEY = "curibot-theme";

function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
    return "system";
  }
}

/**
 * The user's theme choice, remembered in this browser.
 *
 * "system" follows prefers-color-scheme; "light" and "dark" set
 * data-theme on <html>, which pins color-scheme (see index.css).
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;

    if (theme === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }

    try {
      if (theme === "system") {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      }
    } catch {
      // The choice still applies for this visit without storage.
    }
  }, [theme]);

  return { theme, setTheme };
}
