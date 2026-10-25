import { useEffect, useEffectEvent, useState } from "react";
import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
  type ChatTurn,
  type Conversation,
} from "../api/client";
import { getStoredToken } from "../lib/session";
import { deriveTitle } from "../lib/titles";

// Reports a failed request. Returns true if the session expired and the user
// is being signed out, in which case the caller should stop.
export type ReportError = (err: unknown, fallback: string) => boolean;

interface UseConversationsOptions {
  reportError: ReportError;
  clearError: () => void;
}

/** The signed-in user's conversation list and the actions that change it. */
export function useConversations({
  reportError,
  clearError,
}: UseConversationsOptions) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // Lets the load effect report errors without re-running when the
  // callback's identity changes between renders.
  const onLoadError = useEffectEvent((err: unknown) =>
    reportError(err, "Unable to load your conversations."),
  );
  const onLoadStart = useEffectEvent(() => clearError());

  useEffect(() => {
    const token = getStoredToken();

    if (token === null) {
      return;
    }

    let cancelled = false;

    async function load(storedToken: string) {
      setLoading(true);
      onLoadStart();

      try {
        const saved = await listConversations(storedToken);

        if (!cancelled) {
          setConversations(saved);
        }
      } catch (err) {
        if (!cancelled) {
          onLoadError(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load(token);

    return () => {
      cancelled = true;
    };
  }, []);

  /** Create a conversation; resolves to it, or null on failure. */
  async function create(): Promise<Conversation | null> {
    const token = getStoredToken();

    if (!token || creating) {
      return null;
    }

    setCreating(true);
    clearError();

    try {
      const conversation = await createConversation(token);

      setConversations((current) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);

      return conversation;
    } catch (err) {
      reportError(err, "Unable to create a conversation.");
      return null;
    } finally {
      setCreating(false);
    }
  }

  /** Rename optimistically, rolling back if the server rejects it. */
  async function rename(conversation: Conversation, title: string) {
    const token = getStoredToken();

    if (!token) {
      return;
    }

    clearError();
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
      setConversations((current) =>
        current.map((item) =>
          item.id === conversation.id
            ? { ...item, title: conversation.title }
            : item,
        ),
      );
      reportError(err, "Unable to rename the conversation.");
    }
  }

  /** Delete a conversation; resolves to whether it succeeded. */
  async function remove(conversation: Conversation): Promise<boolean> {
    const token = getStoredToken();

    if (!token) {
      return false;
    }

    clearError();

    try {
      await deleteConversation(token, conversation.id);

      setConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );

      return true;
    } catch (err) {
      reportError(err, "Unable to delete the conversation.");
      return false;
    }
  }

  /**
   * Reflect a saved turn: title an untitled conversation the way the backend
   * does, and move it to the top by activity.
   */
  function recordTurn(conversationId: string, content: string, turn: ChatTurn) {
    setConversations((current) =>
      current
        .map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                title: conversation.title ?? deriveTitle(content),
                updated_at: turn.assistant_message.created_at,
              }
            : conversation,
        )
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        ),
    );
  }

  return {
    conversations,
    loading,
    creating,
    create,
    rename,
    remove,
    recordTurn,
  };
}
