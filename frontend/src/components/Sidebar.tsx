import type { ReactNode, Ref } from "react";
import type { User } from "../api/client";
import PlusIcon from "./PlusIcon";
import SettingsMenu from "./SettingsMenu";

interface SidebarProps {
  user: User;
  // Only meaningful on small screens, where the sidebar is a drawer.
  open: boolean;
  onClose: () => void;
  closeButtonRef: Ref<HTMLButtonElement>;
  creating: boolean;
  onNewChat: () => void;
  error: string;
  loading: boolean;
  isEmpty: boolean;
  onOpenMemory: () => void;
  onSignOut: () => void;
  onSettingsOpenChange: (open: boolean) => void;
  // The conversation list.
  children: ReactNode;
}

function Sidebar({
  user,
  open,
  onClose,
  closeButtonRef,
  creating,
  onNewChat,
  error,
  loading,
  isEmpty,
  onOpenMemory,
  onSignOut,
  onSettingsOpenChange,
  children,
}: SidebarProps) {
  return (
    <>
      {open && (
        <div className="sidebar-backdrop" aria-hidden="true" onClick={onClose} />
      )}

      <aside
        id="sidebar"
        className={`sidebar ${open ? "sidebar-open" : ""}`}
        aria-label="Conversations"
      >
        <div className="sidebar-header">
          <div className="brand-mark">C</div>
          <span className="brand-name">Curibot</span>
          <button
            ref={closeButtonRef}
            className="sidebar-close"
            type="button"
            aria-label="Close conversations"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <button
          className="new-chat-button"
          type="button"
          onClick={onNewChat}
          disabled={creating}
        >
          <PlusIcon />
          {creating ? "Creating…" : "New chat"}
        </button>

        <div className="sidebar-section">
          <p className="section-label">YOUR WORKSPACE</p>

          {error && (
            <p className="auth-message auth-error" role="alert">
              {error}
            </p>
          )}

          {loading ? (
            <p className="empty-conversations">Loading conversations...</p>
          ) : isEmpty ? (
            <p className="empty-conversations">
              No conversations yet. Start a new chat to begin.
            </p>
          ) : (
            children
          )}
        </div>

        <div className="sidebar-footer">
          <div className="avatar">{user.email.charAt(0).toUpperCase()}</div>

          <div className="user-info">
            <span className="user-name">{user.email}</span>
            <span className="user-status">Signed in</span>
          </div>

          <SettingsMenu
            onOpenMemory={onOpenMemory}
            onSignOut={onSignOut}
            onOpenChange={onSettingsOpenChange}
          />
        </div>
      </aside>
    </>
  );
}

export default Sidebar;
