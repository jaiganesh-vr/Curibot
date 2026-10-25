import type { ChatTurn } from "./api/client";

// A turn shown while the assistant reply is still streaming in.
export interface PendingTurn {
  conversationId: string;
  userContent: string;
  reply: string;
  // What the assistant is doing before text arrives, e.g. a web search.
  activity: string | null;
  // Increments when a tool call discards earlier text, restarting the reveal.
  segment: number;
  // Set when the server finishes; the turn is committed once revealed.
  savedTurn: ChatTurn | null;
}
