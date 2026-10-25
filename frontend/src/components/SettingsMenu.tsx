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
  const headingId = useId();

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
        <div
          id={panelId}
          className="settings-panel"
          role="group"
          aria-labelledby={headingId}
        >
          <span id={headingId} className="settings-label settings-heading">
            Settings
          </span>

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
        {/* A gear: eight teeth around a centre hole. */}
        <svg className="settings-toggle-icon" {...iconProps} viewBox="0 0 24 24">
          <path d="M10.3 2.8a1.7 1.7 0 0 1 3.4 0l.2 1.1a1.7 1.7 0 0 0 2.4 1l1-.5a1.7 1.7 0 0 1 2.4 2.4l-.5 1a1.7 1.7 0 0 0 1 2.4l1.1.2a1.7 1.7 0 0 1 0 3.4l-1.1.2a1.7 1.7 0 0 0-1 2.4l.5 1a1.7 1.7 0 0 1-2.4 2.4l-1-.5a1.7 1.7 0 0 0-2.4 1l-.2 1.1a1.7 1.7 0 0 1-3.4 0l-.2-1.1a1.7 1.7 0 0 0-2.4-1l-1 .5a1.7 1.7 0 0 1-2.4-2.4l.5-1a1.7 1.7 0 0 0-1-2.4l-1.1-.2a1.7 1.7 0 0 1 0-3.4l1.1-.2a1.7 1.7 0 0 0 1-2.4l-.5-1a1.7 1.7 0 0 1 2.4-2.4l1 .5a1.7 1.7 0 0 0 2.4-1Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  );
}

export default SettingsMenu;
