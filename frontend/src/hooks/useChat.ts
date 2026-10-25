import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  listMessages,
  streamMessage,
  type ChatTurn,
  type Message,
} from "../api/client";
import { getStoredToken } from "../lib/session";
import type { PendingTurn } from "../types";
import type { ReportError } from "./useConversations";

export type SendResult = "sent" | "failed" | "signed-out";

interface UseChatOptions {
  // The open conversation; history reloads when it changes.
  conversationId: string | null;
  reportError: ReportError;
  clearError: () => void;
  onTurnSaved: (conversationId: string, content: string, turn: ChatTurn) => void;
}

/** Message history and streaming replies for the open conversation. */
export function useChat({
  conversationId,
  reportError,
  clearError,
  onTurnSaved,
}: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);

  // Lets an in-flight stream check which conversation is open when it ends.
  const conversationIdRef = useRef<string | null>(null);
  // Latest pending turn for handlers that run after an await.
  const pendingTurnRef = useRef<PendingTurn | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    pendingTurnRef.current = pendingTurn;
  }, [pendingTurn]);

  const onLoadError = useEffectEvent((err: unknown) =>
    reportError(err, "Unable to load this conversation's messages."),
  );
  const onLoadStart = useEffectEvent(() => clearError());

  // Load message history whenever the open conversation changes.
  useEffect(() => {
    const token = getStoredToken();

    if (!conversationId || token === null) {
      return;
    }

    let cancelled = false;

    async function load(storedToken: string, id: string) {
      setLoading(true);
      onLoadStart();
      setMessages([]);

      try {
        const history = await listMessages(storedToken, id);

        if (!cancelled) {
          setMessages(history);
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

    void load(token, conversationId);

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /** Clear the shown history, e.g. right before switching conversations. */
  function resetMessages() {
    setMessages([]);
  }

  /** Stream a reply to `content`; the UI commits it once fully revealed. */
  async function send(content: string): Promise<SendResult> {
    const id = conversationId;
    const token = getStoredToken();

    if (!id || !token) {
      return "failed";
    }

    setSending(true);
    clearError();
    setPendingTurn({
      conversationId: id,
      userContent: content,
      reply: "",
      savedTurn: null,
    });

    let turn: ChatTurn;

    try {
      turn = await streamMessage(token, id, content, (text) =>
        setPendingTurn((current) =>
          current?.conversationId === id
            ? { ...current, reply: current.reply + text }
            : current,
        ),
      );
    } catch (err) {
      const signedOut = reportError(
        err,
        "Unable to send your message. Please try again.",
      );

      if (signedOut) {
        return "signed-out";
      }

      setPendingTurn(null);
      setSending(false);
      return "failed";
    }

    onTurnSaved(id, content, turn);

    if (conversationIdRef.current === id) {
      // The reply finishes revealing, then handleReplyRevealed commits it.
      setPendingTurn((current) =>
        current?.conversationId === id
          ? { ...current, savedTurn: turn }
          : current,
      );
    } else {
      // The saved turn loads with that conversation's history later.
      setPendingTurn(null);
      setSending(false);
    }

    return "sent";
  }

  /** Swap the revealed streaming turn for the saved messages. */
  function handleReplyRevealed() {
    const turn = pendingTurn?.savedTurn;

    if (!pendingTurn || !turn) {
      return;
    }

    if (conversationIdRef.current === pendingTurn.conversationId) {
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

  return {
    messages,
    loading,
    sending,
    // Only the open conversation's in-flight turn is shown.
    visiblePendingTurn:
      pendingTurn !== null && pendingTurn.conversationId === conversationId
        ? pendingTurn
        : null,
    pendingTurn,
    resetMessages,
    send,
    handleReplyRevealed,
    dropFinishedPendingTurn,
  };
}
