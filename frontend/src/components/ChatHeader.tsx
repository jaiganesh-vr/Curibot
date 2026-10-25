import type { Ref } from "react";
import type { ConnectionStatus } from "../hooks/useConnectionStatus";

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  checking: "Connecting…",
  online: "Connected",
  degraded: "Database unavailable",
  offline: "Offline",
};

interface ChatHeaderProps {
  title: string;
  connectionStatus: ConnectionStatus;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  // Focus returns here when the mobile drawer closes.
  sidebarToggleRef: Ref<HTMLButtonElement>;
}

function ChatHeader({
  title,
  connectionStatus,
  sidebarOpen,
  onOpenSidebar,
  sidebarToggleRef,
}: ChatHeaderProps) {
  return (
    <header className="chat-header">
      <button
        ref={sidebarToggleRef}
        className="sidebar-toggle"
        type="button"
        aria-label="Open conversations"
        aria-controls="sidebar"
        aria-expanded={sidebarOpen}
        onClick={onOpenSidebar}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>

      <div className="chat-header-title">
        <p className="header-eyebrow">YOUR AI WORKSPACE</p>
        <h1>{title}</h1>
      </div>

      <span
        className={`connection-status connection-${connectionStatus}`}
        aria-live="polite"
      >
        <span className="status-dot" aria-hidden="true" />
        <span className="connection-label">
          {CONNECTION_LABELS[connectionStatus]}
        </span>
      </span>
    </header>
  );
}

export default ChatHeader;
