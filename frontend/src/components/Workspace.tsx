import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type Conversation, type User } from "../api/client";
import { useChat } from "../hooks/useChat";
import { useChatScroll } from "../hooks/useChatScroll";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { useConversations } from "../hooks/useConversations";
import { SESSION_EXPIRED_NOTICE } from "../lib/session";
import ChatHeader from "./ChatHeader";
import Composer from "./Composer";
import ConfirmDialog from "./ConfirmDialog";
import ConversationList from "./ConversationList";
import MemoryPanel from "./MemoryPanel";
import MessageList from "./MessageList";
import Sidebar from "./Sidebar";
import WelcomeScreen from "./WelcomeScreen";

interface WorkspaceProps {
  user: User;
  // Pass a reason to explain an involuntary sign-out on the login screen.
  onSignOut: (reason?: string) => void;
}

/**
 * The signed-in app: sidebar, conversation, and composer.
 *
 * App renders this keyed by user, so signing out unmounts it and discards
 * every piece of workspace state at once.
 */
function Workspace({ user, onSignOut }: WorkspaceProps) {
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [composer, setComposer] = useState("");
  const [chatError, setChatError] = useState("");

  // The sidebar is an off-canvas drawer on small screens.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // True while a conversation's options menu or rename box is open.
  const [listBusy, setListBusy] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The conversation awaiting delete confirmation, if any.
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  // The options button that opened the dialog; the menu item itself is gone
  // by the time the dialog closes, so focus returns here instead.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const chatContentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);

  // A 401 means the token expired or was revoked: sign out instead of
  // leaving every action failing. Anything else is shown in the sidebar.
  function reportError(err: unknown, fallback: string): boolean {
    if (err instanceof ApiError && err.status === 401) {
      onSignOut(SESSION_EXPIRED_NOTICE);
      return true;
    }

    setChatError(err instanceof ApiError ? err.message : fallback);
    return false;
  }

  function clearError() {
    setChatError("");
  }

  const { status: connectionStatus, recheck: recheckConnection } =
    useConnectionStatus(true);

  const conversationsApi = useConversations({ reportError, clearError });
  const chat = useChat({
    conversationId: selectedConversationId,
    reportError,
    clearError,
    onTurnSaved: conversationsApi.recordTurn,
  });
  const followStreamingReply = useChatScroll(
    chatContentRef,
    chat.messages,
    chat.pendingTurn,
  );

  const selectedConversation =
    conversationsApi.conversations.find(
      (conversation) => conversation.id === selectedConversationId,
    ) ?? null;

  // Put the cursor in the composer whenever a conversation opens.
  useEffect(() => {
    composerRef.current?.focus();
  }, [selectedConversationId]);

  // Move focus into the drawer when it opens.
  useEffect(() => {
    if (sidebarOpen) {
      sidebarCloseRef.current?.focus();
    }
  }, [sidebarOpen]);

  // Close the drawer on Escape, unless a menu, rename, or dialog handles it.
  useEffect(() => {
    if (
      !sidebarOpen ||
      listBusy ||
      settingsOpen ||
      memoryOpen ||
      pendingDelete !== null
    ) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeSidebar(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen, listBusy, settingsOpen, memoryOpen, pendingDelete]);

  function closeSidebar(returnFocus: boolean) {
    setSidebarOpen(false);

    if (returnFocus) {
      sidebarToggleRef.current?.focus();
    }
  }

  function openConversation(conversationId: string) {
    chat.dropFinishedPendingTurn();
    chat.resetMessages();
    setComposer("");
    setSelectedConversationId(conversationId);
  }

  async function handleNewChat() {
    const conversation = await conversationsApi.create();

    if (conversation) {
      closeSidebar(false);
      openConversation(conversation.id);
    }
  }

  function handleSelectConversation(conversationId: string) {
    closeSidebar(false);

    if (conversationId !== selectedConversationId) {
      clearError();
      openConversation(conversationId);
    }
  }

  function handleRequestDelete(
    conversation: Conversation,
    trigger: HTMLButtonElement | null,
  ) {
    deleteTriggerRef.current = trigger;
    setPendingDelete(conversation);
  }

  function handleCancelDelete() {
    setPendingDelete(null);
    deleteTriggerRef.current?.focus();
  }

  async function handleConfirmDelete() {
    const conversation = pendingDelete;

    if (!conversation) {
      return;
    }

    setDeleting(true);

    try {
      const deleted = await conversationsApi.remove(conversation);

      if (!deleted) {
        deleteTriggerRef.current?.focus();
      } else if (conversation.id === selectedConversationId) {
        setSelectedConversationId(null);
        chat.resetMessages();
        setComposer("");
      }
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = composer.trim();

    if (
      !content ||
      !selectedConversationId ||
      chat.sending ||
      chat.loading
    ) {
      return;
    }

    setComposer("");
    // Clicking Send moves focus to the button; return it to the composer.
    composerRef.current?.focus();

    const result = await chat.send(content);

    if (result === "failed") {
      // A failed send may mean the backend went away; refresh the indicator.
      void recheckConnection();
      // Restore the failed message unless the user already typed a new one.
      setComposer((current) => (current.trim() ? current : content));
    }
  }

  return (
    <main className="app-shell">
      <Sidebar
        user={user}
        open={sidebarOpen}
        onClose={() => closeSidebar(true)}
        closeButtonRef={sidebarCloseRef}
        creating={conversationsApi.creating}
        onNewChat={() => void handleNewChat()}
        error={chatError}
        loading={conversationsApi.loading}
        isEmpty={conversationsApi.conversations.length === 0}
        onOpenMemory={() => setMemoryOpen(true)}
        onSignOut={() => onSignOut()}
        onSettingsOpenChange={setSettingsOpen}
      >
        <ConversationList
          conversations={conversationsApi.conversations}
          selectedId={selectedConversationId}
          deleteDisabledId={chat.sending ? selectedConversationId : null}
          onSelect={handleSelectConversation}
          onRename={(conversation, title) =>
            void conversationsApi.rename(conversation, title)
          }
          onRequestDelete={handleRequestDelete}
          onBusyChange={setListBusy}
        />
      </Sidebar>

      <section className="chat-panel">
        <ChatHeader
          title={selectedConversation?.title || "Curibot"}
          connectionStatus={connectionStatus}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          sidebarToggleRef={sidebarToggleRef}
        />

        <div className="chat-content" ref={chatContentRef}>
          {!selectedConversationId ? (
            <WelcomeScreen
              creating={conversationsApi.creating}
              onNewChat={() => void handleNewChat()}
            />
          ) : (
            <MessageList
              messages={chat.messages}
              loading={chat.loading}
              pendingTurn={chat.visiblePendingTurn}
              onReplyRevealed={chat.handleReplyRevealed}
              onReplyGrow={followStreamingReply}
            />
          )}
        </div>

        {selectedConversationId && (
          <Composer
            value={composer}
            onChange={setComposer}
            onSubmit={handleSendMessage}
            sendBlocked={chat.sending || chat.loading}
            textareaRef={composerRef}
          />
        )}
      </section>

      <MemoryPanel
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        onSessionExpired={() => onSignOut(SESSION_EXPIRED_NOTICE)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete conversation?"
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={handleCancelDelete}
      >
        {pendingDelete?.title ? (
          <>
            <strong>{pendingDelete.title}</strong> and all of its messages
            will be permanently deleted.
          </>
        ) : (
          "This conversation and all of its messages will be permanently deleted."
        )}
      </ConfirmDialog>
    </main>
  );
}

export default Workspace;
