import type { ChatTurn } from "./api/client";

// A turn shown while the assistant reply is still streaming in.
export interface PendingTurn {
  conversationId: string;
  userContent: string;
  reply: string;
  // Set when the server finishes; the turn is committed once revealed.
  savedTurn: ChatTurn | null;
}
