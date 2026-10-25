import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ApiError,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  renameConversation,
  streamMessage,
  type ChatTurn,
  type Conversation,
  type Message,
  type User,
} from "../api/client";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { getStoredToken, SESSION_EXPIRED_NOTICE } from "../lib/session";
import type { PendingTurn } from "../types";
import ChatHeader from "./ChatHeader";
import Composer from "./Composer";
import ConfirmDialog from "./ConfirmDialog";
import MessageList from "./MessageList";
import PlusIcon from "./PlusIcon";
import ThemeSwitcher from "./ThemeSwitcher";
import WelcomeScreen from "./WelcomeScreen";

// Follow streaming text only while the reader is already near the bottom.
const STICK_TO_BOTTOM_THRESHOLD_PX = 160;

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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] =
    useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [composer, setComposer] = useState("");

  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);

  const [chatError, setChatError] = useState("");

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // The sidebar is an off-canvas drawer on small screens.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The conversation awaiting delete confirmation, if any.
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  // The options button that opened the dialog; the menu item itself is gone
  // by the time the dialog closes, so focus returns here instead.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const { status: connectionStatus, recheck: recheckConnection } =
    useConnectionStatus(true);

  const chatContentRef = useRef<HTMLDivElement>(null);
  // Lets an in-flight stream check which conversation is open when it ends.
  const selectedConversationIdRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  // Latest pending turn for handlers that run after an await.
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  // Enter, Escape, and blur can all end a rename; only the first one counts.
  const renameFinishedRef = useRef(false);

  const selectedConversation =
    conversations.find(
      (conversation) => conversation.id === selectedConversationId,
    ) ?? null;

  const showPendingTurn =
    pendingTurn !== null &&
    pendingTurn.conversationId === selectedConversationId;

  // Lets the loading effects sign out on a 401 without re-running when the
  // handler's identity changes between renders.
  const onLoadError = useEffectEvent((err: unknown) =>
    handleSessionExpired(err),
  );


  // Load the authenticated user's conversations.
  useEffect(() => {
    if (!user) {
      return;
    }

    const token = getStoredToken();

    if (token === null) {
      return;
    }

    let cancelled = false;

    async function loadWorkspace() {
      setWorkspaceLoading(true);
      setChatError("");

      try {
        const savedConversations = await listConversations(token!);

        if (!cancelled) {
          setConversations(savedConversations);
        }
      } catch (err) {
        if (!cancelled && !onLoadError(err)) {
          setChatError(
            err instanceof ApiError
              ? err.message
              : "Unable to load your conversations.",
          );
        }
      } finally {
        if (!cancelled) {
          setWorkspaceLoading(false);
        }
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Load message history whenever the selected conversation changes.
  useEffect(() => {
    if (!user || !selectedConversationId) {
      return;
    }

    const token = getStoredToken();

    if (token === null) {
      return;
    }

    let cancelled = false;

    async function loadHistory() {
      setMessagesLoading(true);
      setChatError("");
      setMessages([]);

      try {
        const history = await listMessages(
          token!,
          selectedConversationId!,
        );

        if (!cancelled) {
          setMessages(history);
        }
      } catch (err) {
        if (!cancelled && !onLoadError(err)) {
          setChatError(
            err instanceof ApiError
              ? err.message
              : "Unable to load this conversation's messages.",
          );
        }
      } finally {
        if (!cancelled) {
          setMessagesLoading(false);
        }
      }
    }

    void loadHistory();

    return () => {
      cancelled = true;
    };
  }, [user, selectedConversationId]);

  // Track the open chat and put the cursor in its composer, ready to type.
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
    composerRef.current?.focus();
  }, [selectedConversationId]);

  // Jump to the newest message when history loads or a turn is saved.
  useEffect(() => {
    const chatContent = chatContentRef.current;

    if (chatContent) {
      chatContent.scrollTop = chatContent.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    pendingTurnRef.current = pendingTurn;
  }, [pendingTurn]);

  // Bring a newly sent message and its "Thinking..." indicator into view.
  const pendingStarted = pendingTurn !== null && pendingTurn.reply === "";

  useEffect(() => {
    const chatContent = chatContentRef.current;

    if (chatContent && pendingStarted) {
      chatContent.scrollTop = chatContent.scrollHeight;
    }
  }, [pendingStarted]);

  // Follow a revealing reply unless the user has scrolled up to read.
  const followStreamingReply = useCallback(() => {
    const chatContent = chatContentRef.current;

    if (!chatContent) {
      return;
    }

    const distanceFromBottom =
      chatContent.scrollHeight -
      chatContent.scrollTop -
      chatContent.clientHeight;

    if (distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD_PX) {
      chatContent.scrollTop = chatContent.scrollHeight;
    }
  }, []);

  // Move focus into the drawer when it opens.
  useEffect(() => {
    if (sidebarOpen) {
      sidebarCloseRef.current?.focus();
    }
  }, [sidebarOpen]);

  // Close the drawer on Escape, unless a menu or rename handles it first.
  useEffect(() => {
    if (
      !sidebarOpen ||
      openMenuId !== null ||
      renamingId !== null ||
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
  }, [sidebarOpen, openMenuId, renamingId, pendingDelete]);

  // Close the conversation options menu on an outside click or Escape.
  useEffect(() => {
    if (openMenuId === null) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-conversation-menu]")
      ) {
        setOpenMenuId(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenuId(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenuId]);


  async function handleNewChat() {
    const token = getStoredToken();

    if (!token || creatingConversation) {
      return;
    }

    setCreatingConversation(true);
    setChatError("");

    try {
      const conversation = await createConversation(token);

      setConversations((current) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);

      dropFinishedPendingTurn();
      closeSidebar(false);
      setMessages([]);
      setComposer("");
      setSelectedConversationId(conversation.id);
    } catch (err) {
      if (handleSessionExpired(err)) {
        return;
      }

      setChatError(
        err instanceof ApiError
          ? err.message
          : "Unable to create a conversation.",
      );
    } finally {
      setCreatingConversation(false);
    }
  }

  function handleStartRename(conversation: Conversation) {
    renameFinishedRef.current = false;
    setOpenMenuId(null);
    setRenameDraft(conversation.title ?? "");
    setRenamingId(conversation.id);
  }

  function handleCancelRename() {
    renameFinishedRef.current = true;
    setRenamingId(null);
  }

  async function handleRenameSubmit(conversation: Conversation) {
    if (renameFinishedRef.current) {
      return;
    }

    renameFinishedRef.current = true;
    setRenamingId(null);

    const title = renameDraft.trim();
    const token = getStoredToken();

    if (!title || title === conversation.title || !token) {
      return;
    }

    setChatError("");
    setConversations((current) =>
      current.map((item) =>
        item.id === conversation.id ? { ...item, title } : item,
      ),
    );

    try {
      const updated = await renameConversation(token, conversation.id, title);

      setConversations((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (err) {
      if (handleSessionExpired(err)) {
        return;
      }

      setConversations((current) =>
        current.map((item) =>
          item.id === conversation.id
            ? { ...item, title: conversation.title }
            : item,
        ),
      );
      setChatError(
        err instanceof ApiError
          ? err.message
          : "Unable to rename the conversation.",
      );
    }
  }

  function handleDeleteConversation(
    conversation: Conversation,
    trigger: HTMLButtonElement | null,
  ) {
    deleteTriggerRef.current = trigger;
    setOpenMenuId(null);
    setPendingDelete(conversation);
  }

  function handleCancelDelete() {
    setPendingDelete(null);
    deleteTriggerRef.current?.focus();
  }

  async function handleConfirmDelete() {
    const conversation = pendingDelete;
    const token = getStoredToken();

    if (!conversation || !token) {
      setPendingDelete(null);
      return;
    }

    setChatError("");
    setDeleting(true);

    try {
      await deleteConversation(token, conversation.id);

      setConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );

      if (conversation.id === selectedConversationId) {
        setSelectedConversationId(null);
        setMessages([]);
        setComposer("");
      }
    } catch (err) {
      if (handleSessionExpired(err)) {
        return;
      }

      setChatError(
        err instanceof ApiError
          ? err.message
          : "Unable to delete the conversation.",
      );
      deleteTriggerRef.current?.focus();
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  function closeSidebar(returnFocus: boolean) {
    setSidebarOpen(false);

    if (returnFocus) {
      sidebarToggleRef.current?.focus();
    }
  }

  function handleSelectConversation(conversationId: string) {
    setOpenMenuId(null);
    closeSidebar(false);

    if (conversationId === selectedConversationId) {
      return;
    }

    dropFinishedPendingTurn();

    setSelectedConversationId(conversationId);
    setComposer("");
    setMessages([]);
    setChatError("");
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = composer.trim();
    const conversationId = selectedConversationId;
    const token = getStoredToken();

    if (
      !content ||
      !conversationId ||
      !token ||
      sending ||
      messagesLoading
    ) {
      return;
    }

    setSending(true);
    setChatError("");
    setComposer("");
    setPendingTurn({
      conversationId,
      userContent: content,
      reply: "",
      savedTurn: null,
    });
    // Clicking Send moves focus to the button; return it to the composer.
    composerRef.current?.focus();

    let turn: ChatTurn;

    try {
      turn = await streamMessage(
        token,
        conversationId,
        content,
        (text) =>
          setPendingTurn((current) =>
            current?.conversationId === conversationId
              ? { ...current, reply: current.reply + text }
              : current,
          ),
      );

    } catch (err) {
      if (handleSessionExpired(err)) {
        return;
      }

      // A failed send may mean the backend went away; refresh the indicator.
      void recheckConnection();

      // Restore the failed message unless the user already typed a new one.
      setComposer((current) => (current.trim() ? current : content));
      setChatError(
        err instanceof ApiError
          ? err.message
          : "Unable to send your message. Please try again.",
      );
      setPendingTurn(null);
      setSending(false);
      return;
    }

    setConversations((current) => {
        const updated = current.map((conversation) =>
          conversation.id === conversationId
            ? {
              ...conversation,
              title:
                conversation.title ??
                content.replace(/\s+/g, " ").slice(0, 60),
              updated_at: turn.assistant_message.created_at,
            }
            : conversation,
        );

        return updated.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() -
            new Date(a.updated_at).getTime(),
        );
      });

    if (selectedConversationIdRef.current === conversationId) {
      // StreamingReply finishes revealing, then handleReplyRevealed commits.
      setPendingTurn((current) =>
        current?.conversationId === conversationId
          ? { ...current, savedTurn: turn }
          : current,
      );
    } else {
      // The saved turn loads with that conversation's history later.
      setPendingTurn(null);
      setSending(false);
    }
  }

  function handleReplyRevealed() {
    const turn = pendingTurn?.savedTurn;

    if (!pendingTurn || !turn) {
      return;
    }

    if (selectedConversationIdRef.current === pendingTurn.conversationId) {
      setMessages((current) => [
        ...current,
        turn.user_message,
        turn.assistant_message,
      ]);
    }

    setPendingTurn(null);
    setSending(false);
  }

  // A finished turn that is still revealing needs no animation once the user
  // leaves its conversation; it is already saved and loads with the history.
  function dropFinishedPendingTurn() {
    if (pendingTurnRef.current?.savedTurn) {
      setPendingTurn(null);
      setSending(false);
    }
  }


  // An authenticated request rejected with 401 means the token expired or
  // was revoked; sign out instead of leaving every action failing.
  function handleSessionExpired(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      onSignOut(SESSION_EXPIRED_NOTICE);
      return true;
    }

    return false;
  }

  return (
    <main className="app-shell">
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => closeSidebar(true)}
        />
      )}

      <aside
        id="sidebar"
        className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}
        aria-label="Conversations"
      >
        <div className="sidebar-header">
          <div className="brand-mark">C</div>
          <span className="brand-name">Curibot</span>
          <button
            ref={sidebarCloseRef}
            className="sidebar-close"
            type="button"
            aria-label="Close conversations"
            onClick={() => closeSidebar(true)}
          >
            ×
          </button>
        </div>

        <button
          className="new-chat-button"
          type="button"
          onClick={() => void handleNewChat()}
          disabled={creatingConversation}
        >
          <PlusIcon />
          {creatingConversation ? "Creating…" : "New chat"}
        </button>

        <div className="sidebar-section">
          <p className="section-label">YOUR WORKSPACE</p>

          {chatError && (
            <p className="auth-message auth-error" role="alert">
              {chatError}
            </p>
          )}

          {workspaceLoading ? (
            <p className="empty-conversations">
              Loading conversations...
            </p>
          ) : conversations.length === 0 ? (
            <p className="empty-conversations">
              No conversations yet. Start a new chat to begin.
            </p>
          ) : (
            <ul className="conversation-list">
              {conversations.map((conversation) => {
                const title = conversation.title || "New conversation";
                const menuOpen = openMenuId === conversation.id;

                return (
                  <li
                    key={conversation.id}
                    className={
                      menuOpen ? "conversation-row-menu-open" : undefined
                    }
                  >
                    {renamingId === conversation.id ? (
                      <form
                        className="conversation-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void handleRenameSubmit(conversation);
                        }}
                      >
                        <input
                          aria-label="Conversation title"
                          value={renameDraft}
                          maxLength={200}
                          autoFocus
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          onBlur={() => void handleRenameSubmit(conversation)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              handleCancelRename();
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <>
                        <button
                          className={`conversation-item ${conversation.id === selectedConversationId
                            ? "conversation-item-active"
                            : ""
                            }`}
                          type="button"
                          onClick={() =>
                            handleSelectConversation(conversation.id)
                          }
                          aria-current={
                            conversation.id === selectedConversationId
                              ? "page"
                              : undefined
                          }
                        >
                          {title}
                        </button>

                        <div
                          className="conversation-actions"
                          data-conversation-menu
                        >
                          <button
                            className="conversation-menu-button"
                            type="button"
                            aria-label={`Options for ${title}`}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() =>
                              setOpenMenuId(
                                menuOpen ? null : conversation.id,
                              )
                            }
                          >
                            <span className="conversation-menu-dot" />
                            <span className="conversation-menu-dot" />
                            <span className="conversation-menu-dot" />
                          </button>

                          {menuOpen && (
                            <div className="conversation-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                  handleStartRename(conversation)
                                }
                              >
                                Rename
                              </button>
                              <button
                                className="conversation-menu-danger"
                                type="button"
                                role="menuitem"
                                disabled={
                                  sending &&
                                  conversation.id === selectedConversationId
                                }
                                onClick={(event) =>
                                  handleDeleteConversation(
                                    conversation,
                                    event.currentTarget
                                      .closest("[data-conversation-menu]")
                                      ?.querySelector<HTMLButtonElement>(
                                        ".conversation-menu-button",
                                      ) ?? null,
                                  )
                                }
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <ThemeSwitcher />

        <div className="sidebar-footer">
          <div className="avatar">
            {user.email.charAt(0).toUpperCase()}
          </div>

          <div className="user-info">
            <span className="user-name">{user.email}</span>
            <span className="user-status">Signed in</span>
          </div>

          <button
            className="logout-button"
            type="button"
            onClick={() => onSignOut()}
          >
            Log out
          </button>
        </div>
      </aside>

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
              creating={creatingConversation}
              onNewChat={() => void handleNewChat()}
            />
          ) : (
            <MessageList
              messages={messages}
              loading={messagesLoading}
              pendingTurn={showPendingTurn ? pendingTurn : null}
              onReplyRevealed={handleReplyRevealed}
              onReplyGrow={followStreamingReply}
            />
          )}
        </div>

        {selectedConversationId && (
          <Composer
            value={composer}
            onChange={setComposer}
            onSubmit={handleSendMessage}
            sendBlocked={sending || messagesLoading}
            textareaRef={composerRef}
          />
        )}
      </section>

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
