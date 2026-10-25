import { useEffect, useId, useRef, useState } from "react";
import ThemeSwitcher from "./ThemeSwitcher";

interface SettingsMenuProps {
  onOpenMemory: () => void;
  onSignOut: () => void;
  // Lets the mobile drawer leave Escape to this menu while it is open.
  onOpenChange: (open: boolean) => void;
}

const iconProps = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/**
 * The sidebar's settings button and the panel it opens: memory, theme, and
 * sign out.
 *
 * A disclosure (a button with aria-expanded controlling a panel) rather
 * than an ARIA menu, because the panel holds the theme switcher's group of
 * toggle buttons, which a role="menu" may not contain.
 */
function SettingsMenu({ onOpenMemory, onSignOut, onOpenChange }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    onOpenChange(open);
  }, [open, onOpenChange]);

  // Focus the first item on open; close on an outside click or Escape.
  useEffect(() => {
    if (!open) {
      return;
    }

    firstItemRef.current?.focus();

    function handlePointerDown(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="settings" ref={containerRef}>
      {open && (
        <div id={panelId} className="settings-panel" aria-label="Settings">
          <button
            ref={firstItemRef}
            className="settings-item"
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenMemory();
            }}
          >
            <svg className="settings-item-icon" {...iconProps}>
              <path d="M4 2.5h8a.5.5 0 0 1 .5.5v10.5L8 11l-4.5 2.5V3a.5.5 0 0 1 .5-.5Z" />
            </svg>
            Memory
          </button>

          <div className="settings-theme">
            <span className="settings-label">Theme</span>
            <ThemeSwitcher />
          </div>

          <div className="settings-divider" />

          <button
            className="settings-item settings-item-danger"
            type="button"
            onClick={onSignOut}
          >
            <svg className="settings-item-icon" {...iconProps}>
              <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.5 8H6" />
            </svg>
            Log out
          </button>
        </div>
      )}

      <button
        ref={toggleRef}
        className="settings-toggle"
        type="button"
        aria-label="Settings"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <svg className="settings-toggle-icon" {...iconProps}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
        </svg>
      </button>
    </div>
  );
}

export default SettingsMenu;
