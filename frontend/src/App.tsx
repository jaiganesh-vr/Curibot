
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
  getMe,
  listConversations,
  listMessages,
  login,
  register,
  renameConversation,
  streamMessage,
  type ChatTurn,
  type Conversation,
  type Message,
  type User,
} from "./api/client";
import ConfirmDialog from "./ConfirmDialog";
import MarkdownMessage from "./MarkdownMessage";
import StreamingReply from "./StreamingReply";
import ThemeSwitcher from "./ThemeSwitcher";
import {
  useConnectionStatus,
  type ConnectionStatus,
} from "./useConnectionStatus";
import { useTheme } from "./useTheme";
import "./App.css";

type AuthMode = "login" | "register";

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  checking: "Connecting…",
  online: "Connected",
  degraded: "Database unavailable",
  offline: "Offline",
};

const SESSION_EXPIRED_NOTICE = "Your session has expired. Please sign in again.";

// A turn shown while the assistant reply is still streaming in.
interface PendingTurn {
  conversationId: string;
  userContent: string;
  reply: string;
  // Set when the server finishes; the turn is committed once revealed.
  savedTurn: ChatTurn | null;
}

// Follow streaming text only while the reader is already near the bottom.
const STICK_TO_BOTTOM_THRESHOLD_PX = 160;

function PlusIcon() {
  return (
    <svg
      className="new-chat-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getStoredToken(): string | null {
  return sessionStorage.getItem("access_token");
}

function App() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<User | null>(null);
  // A stored token is verified before choosing between login and workspace,
  // so a signed-in user does not see the login form flash on refresh.
  const [restoringSession, setRestoringSession] = useState(
    () => getStoredToken() !== null,
  );

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

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

  const { theme, setTheme } = useTheme();

  const { status: connectionStatus, recheck: recheckConnection } =
    useConnectionStatus(user !== null);

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

  // Restore the authenticated session after a page refresh.
  useEffect(() => {
    const token = getStoredToken();

    if (token === null) {
      return;
    }

    let cancelled = false;

    async function restoreSession() {
      try {
        const authenticatedUser = await getMe(token!);

        if (!cancelled) {
          setUser(authenticatedUser);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        if (err instanceof ApiError && err.status === 401) {
          sessionStorage.removeItem("access_token");
          setUser(null);
          return;
        }

        setError(
          "Unable to verify your session. Check your connection and try again.",
        );
      } finally {
        if (!cancelled) {
          setRestoringSession(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);

    try {
      if (mode === "register") {
        await register(email.trim(), password);
        setMode("login");
        setPassword("");
        setNotice("Account created. Please sign in.");
        return;
      }

      const tokenResponse = await login(email.trim(), password);
      const authenticatedUser = await getMe(tokenResponse.access_token);

      sessionStorage.setItem(
        "access_token",
        tokenResponse.access_token,
      );

      setConversations([]);
      setMessages([]);
      setSelectedConversationId(null);
      setUser(authenticatedUser);
      setPassword("");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Unable to connect to the server. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
    }
  }

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

  // Pass a notice to explain an involuntary sign-out on the login screen.
  function handleLogout(reason?: string) {
    sessionStorage.removeItem("access_token");

    setUser(null);
    setRestoringSession(false);
    // Keep the email after an expiry so signing back in is one step.
    setEmail(reason && user ? user.email : "");
    setPassword("");
    setError("");
    setNotice(reason ?? "");
    setConversations([]);
    setSelectedConversationId(null);
    setMessages([]);
    setComposer("");
    setChatError("");
    setWorkspaceLoading(false);
    setMessagesLoading(false);
    setCreatingConversation(false);
    setSending(false);
    setPendingTurn(null);
    setOpenMenuId(null);
    setRenamingId(null);
    setSidebarOpen(false);
    setPendingDelete(null);
    setDeleting(false);
    setMode("login");
  }

  // An authenticated request rejected with 401 means the token expired or
  // was revoked; sign out instead of leaving every action failing.
  function handleSessionExpired(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      handleLogout(SESSION_EXPIRED_NOTICE);
      return true;
    }

    return false;
  }

  if (restoringSession) {
    return (
      <main className="auth-page">
        <div className="session-restoring" role="status">
          <div className="brand-mark" aria-hidden="true">
            C
          </div>
          <p>Restoring your session…</p>
        </div>
      </main>
    );
  }

  if (user) {
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

          <ThemeSwitcher theme={theme} onChange={setTheme} />

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
              onClick={() => handleLogout()}
            >
              Log out
            </button>
          </div>
        </aside>

        <section className="chat-panel">
          <header className="chat-header">
            <button
              ref={sidebarToggleRef}
              className="sidebar-toggle"
              type="button"
              aria-label="Open conversations"
              aria-controls="sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>

            <div className="chat-header-title">
              <p className="header-eyebrow">YOUR AI WORKSPACE</p>
              <h1>
                {selectedConversation?.title || "Curibot"}
              </h1>
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

          <div className="chat-content" ref={chatContentRef}>
            {!selectedConversationId ? (
              <div className="welcome-content">
                <div className="welcome-icon" aria-hidden="true">
                  ✳
                </div>

                <h2>Your AI workspace</h2>

                <p>
                  Start a new conversation to ask a question and
                  interact with your AI assistant. Your conversations
                  are saved to your account.
                </p>

                <button
                  className="new-chat-button welcome-new-chat"
                  type="button"
                  onClick={() => void handleNewChat()}
                  disabled={creatingConversation}
                >
                  <PlusIcon />
                  {creatingConversation ? "Creating…" : "Start a new chat"}
                </button>
              </div>
            ) : (
              <div className="conversation-view">
                <div className="message-list" aria-live="polite">
                  {messagesLoading ? (
                    <p className="chat-status">
                      Loading messages...
                    </p>
                  ) : messages.length === 0 && !showPendingTurn ? (
                    <div className="conversation-empty">
                      <h2>What would you like to explore?</h2>
                      <p>Send a message to start this conversation.</p>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article
                        className={`message message-${message.role}`}
                        key={message.id}
                      >
                        <div className="message-avatar">
                          {message.role === "user" ? "Y" : "C"}
                        </div>

                        <div className="message-body">
                          <p className="message-role">
                            {message.role === "user"
                              ? "You"
                              : "Assistant"}
                          </p>
                          {message.role === "assistant" ? (
                            <MarkdownMessage content={message.content} />
                          ) : (
                            <p className="message-text">
                              {message.content}
                            </p>
                          )}
                        </div>
                      </article>
                    ))
                  )}

                  {showPendingTurn && pendingTurn && (
                    <>
                      <article className="message message-user">
                        <div className="message-avatar">Y</div>
                        <div className="message-body">
                          <p className="message-role">You</p>
                          <p className="message-text">
                            {pendingTurn.userContent}
                          </p>
                        </div>
                      </article>

                      <StreamingReply
                        text={pendingTurn.reply}
                        complete={pendingTurn.savedTurn !== null}
                        onRevealed={handleReplyRevealed}
                        onGrow={followStreamingReply}
                      />
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {selectedConversationId && (
            <>
              <form
                className="composer"
                onSubmit={handleSendMessage}
              >
                {/*
                  The textarea stays editable during a reply so the next
                  message can be drafted; handleSendMessage blocks sending.
                  Disabling it would also drop keyboard focus.
                */}
                <textarea
                  ref={composerRef}
                  aria-label="Message"
                  placeholder="Message Curibot..."
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={2}
                />

                <div className="composer-footer">
                  <span>Enter to send · Shift+Enter for a new line</span>

                  <button
                    type="submit"
                    aria-label="Send message"
                    disabled={
                      !composer.trim() ||
                      sending ||
                      messagesLoading
                    }
                  >
                    ↑
                  </button>
                </div>
              </form>

              <p className="disclaimer">
                AI responses may be inaccurate. Verify important information.
              </p>
            </>
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

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">C</div>
          <span className="brand-name">Curibot</span>
        </div>

        <div className="auth-heading">
          <h1>
            {mode === "login"
              ? "Welcome back"
              : "Create your account"}
          </h1>

          <p>
            {mode === "login"
              ? "Sign in to continue to your AI workspace."
              : "Create an account to get started."}
          </p>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "auth-tab active" : "auth-tab"}
            onClick={() => {
              setMode("login");
              setError("");
              setNotice("");
            }}
          >
            Sign in
          </button>

          <button
            type="button"
            className={
              mode === "register" ? "auth-tab active" : "auth-tab"
            }
            onClick={() => {
              setMode("register");
              setError("");
              setNotice("");
            }}
          >
            Register
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email address</label>

          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="password">Password</label>

          <input
            id="password"
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            placeholder={
              mode === "register"
                ? "At least 12 characters"
                : "Enter your password"
            }
            minLength={mode === "register" ? 12 : 1}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          {error && (
            <p className="auth-message auth-error" role="alert">
              {error}
            </p>
          )}

          {notice && (
            <p className="auth-message auth-success" role="status">
              {notice}
            </p>
          )}

          <button
            className="auth-submit"
            type="submit"
            disabled={loading}
          >
            {loading
              ? "Please wait..."
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <p className="auth-footnote">
          Your conversations are saved privately to your account.
        </p>
      </section>
    </main>
  );
}

export default App;
