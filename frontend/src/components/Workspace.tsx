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
import ConversationList from "./ConversationList";
import MessageList from "./MessageList";
import Sidebar from "./Sidebar";
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

  // True while a conversation's options menu or rename box is open.
  const [listBusy, setListBusy] = useState(false);
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
    if (!sidebarOpen || listBusy || pendingDelete !== null) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeSidebar(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen, listBusy, pendingDelete]);

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

  async function handleRename(conversation: Conversation, title: string) {
    const token = getStoredToken();

    if (!token) {
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
      <Sidebar
        user={user}
        open={sidebarOpen}
        onClose={() => closeSidebar(true)}
        closeButtonRef={sidebarCloseRef}
        creating={creatingConversation}
        onNewChat={() => void handleNewChat()}
        error={chatError}
        loading={workspaceLoading}
        isEmpty={conversations.length === 0}
        onSignOut={() => onSignOut()}
      >
        <ConversationList
          conversations={conversations}
          selectedId={selectedConversationId}
          deleteDisabledId={sending ? selectedConversationId : null}
          onSelect={handleSelectConversation}
          onRename={(conversation, title) =>
            void handleRename(conversation, title)
          }
          onRequestDelete={handleDeleteConversation}
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
