import { useCallback, useEffect, type RefObject } from "react";
import type { Message } from "../api/client";
import type { PendingTurn } from "../types";

// Follow streaming text only while the reader is already near the bottom.
const STICK_TO_BOTTOM_THRESHOLD_PX = 160;

/**
 * Keep the chat scrolled sensibly: jump to the newest message when history
 * loads or a turn is saved, bring a just-sent message into view, and follow
 * a revealing reply unless the user has scrolled up to read.
 *
 * Returns the follow callback for StreamingReply's onGrow.
 */
export function useChatScroll(
  containerRef: RefObject<HTMLElement | null>,
  messages: Message[],
  pendingTurn: PendingTurn | null,
) {
  useEffect(() => {
    const container = containerRef.current;

    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [containerRef, messages]);

  const pendingStarted = pendingTurn !== null && pendingTurn.reply === "";

  useEffect(() => {
    const container = containerRef.current;

    if (container && pendingStarted) {
      container.scrollTop = container.scrollHeight;
    }
  }, [containerRef, pendingStarted]);

  return useCallback(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    if (distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD_PX) {
      container.scrollTop = container.scrollHeight;
    }
  }, [containerRef]);
}
