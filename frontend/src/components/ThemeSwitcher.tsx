import type { ReactNode } from "react";
import { useTheme, type ThemePreference } from "../hooks/useTheme";

const iconProps = {
  className: "theme-icon",
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: "system",
    label: "System",
    icon: (
      <svg {...iconProps}>
        <rect x="2" y="3" width="12" height="8" rx="1.5" />
        <path d="M6 14h4M8 11v3" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg {...iconProps}>
        <circle cx="8" cy="8" r="2.75" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg {...iconProps}>
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
      </svg>
    ),
  },
];

// Owns the theme choice: nothing else in the app reads it.
function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="theme-switcher" role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          className="theme-option"
          type="button"
          aria-pressed={theme === option.value}
          onClick={() => setTheme(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default ThemeSwitcher;
