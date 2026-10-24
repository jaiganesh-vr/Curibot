
import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createConversation,
  getMe,
  listConversations,
  listMessages,
  login,
  register,
  sendMessage,
  type Conversation,
  type Message,
  type User,
} from "./api/client";
import "./App.css";

type AuthMode = "login" | "register";

function getStoredToken(): string | null {
  return sessionStorage.getItem("access_token");
}

function App() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<User | null>(null);

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

  const [chatError, setChatError] = useState("");

  const selectedConversation =
    conversations.find(
      (conversation) => conversation.id === selectedConversationId,
    ) ?? null;

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
      } catch {
        if (!cancelled) {
          sessionStorage.removeItem("access_token");
          setUser(null);
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
        if (!cancelled) {
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
        if (!cancelled) {
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

      setMessages([]);
      setComposer("");
      setSelectedConversationId(conversation.id);
    } catch (err) {
      setChatError(
        err instanceof ApiError
          ? err.message
          : "Unable to create a conversation.",
      );
    } finally {
      setCreatingConversation(false);
    }
  }

  function handleSelectConversation(conversationId: string) {
    if (conversationId === selectedConversationId) {
      return;
    }

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

    try {
      const turn = await sendMessage(token, conversationId, content);

      setMessages((current) => [
        ...current,
        turn.user_message,
        turn.assistant_message,
      ]);

      setConversations((current) => {
        const updated = current.map((conversation) =>
          conversation.id === conversationId
            ? {
              ...conversation,
              title:
                conversation.title ??
                content.slice(0, 60),
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
    } catch (err) {
      setComposer(content);
      setChatError(
        err instanceof ApiError
          ? err.message
          : "Unable to send your message. Please try again.",
      );
    } finally {
      setSending(false);
    }
  }

  function handleLogout() {
    sessionStorage.removeItem("access_token");

    setUser(null);
    setEmail("");
    setPassword("");
    setError("");
    setNotice("");
    setConversations([]);
    setSelectedConversationId(null);
    setMessages([]);
    setComposer("");
    setChatError("");
    setWorkspaceLoading(false);
    setMessagesLoading(false);
    setCreatingConversation(false);
    setSending(false);
    setMode("login");
  }

  if (user) {
    return (
      <main className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="brand-mark">S</div>
            <span className="brand-name">Stateful AI</span>
          </div>

          <button
            className="new-chat-button"
            type="button"
            onClick={() => void handleNewChat()}
            disabled={creatingConversation}
          >
            <span aria-hidden="true">+</span>
            {creatingConversation ? "Creating..." : "New Chat"}
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
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
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
                      {conversation.title || "New conversation"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

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
              onClick={handleLogout}
            >
              Log out
            </button>
          </div>
        </aside>

        <section className="chat-panel">
          <header className="chat-header">
            <div>
              <p className="header-eyebrow">YOUR AI WORKSPACE</p>
              <h1>
                {selectedConversation?.title || "Stateful AI"}
              </h1>
            </div>

            <span className="connection-status">
              <span className="status-dot status-dot-online" />
              API connected
            </span>
          </header>

          <div className="chat-content">
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
                  <span aria-hidden="true">+</span>
                  {creatingConversation
                    ? "Creating..."
                    : "Start a new chat"}
                </button>
              </div>
            ) : (
              <div className="conversation-view">
                <div className="message-list" aria-live="polite">
                  {messagesLoading ? (
                    <p className="chat-status">
                      Loading messages...
                    </p>
                  ) : messages.length === 0 && !sending ? (
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
                          {message.role === "user" ? "Y" : "S"}
                        </div>

                        <div className="message-body">
                          <p className="message-role">
                            {message.role === "user"
                              ? "You"
                              : "Assistant"}
                          </p>
                          <p className="message-text">
                            {message.content}
                          </p>
                        </div>
                      </article>
                    ))
                  )}

                  {sending && (
                    <div className="message message-assistant">
                      <div className="message-avatar">S</div>
                      <div className="message-body">
                        <p className="message-role">Assistant</p>
                        <p className="message-text">
                          Thinking...
                        </p>
                      </div>
                    </div>
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
                <textarea
                  aria-label="Message"
                  placeholder="Message Stateful AI..."
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
                  disabled={sending || messagesLoading}
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
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">S</div>
          <span className="brand-name">Stateful AI</span>
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
          Secure authentication powered by your FastAPI backend.
        </p>
      </section>
    </main>
  );
}

export default App;
