// Mirrors derive_title in backend/app/services/conversations.py, so the title
// shown right after a first message matches the one saved by the server.
const TITLE_MAX_LENGTH = 50;
const TITLE_ELLIPSIS = "…";

// Matches TITLE_INPUT_MAX_LENGTH in backend/app/schemas/conversation.py.
export const TITLE_INPUT_MAX_LENGTH = 100;

/**
 * Build a conversation title from the first user message: collapse
 * whitespace, and cut longer text at a word boundary (when one falls in the
 * second half of the limit) with an ellipsis.
 */
export function deriveTitle(content: string): string | null {
  const text = content.split(/\s+/).filter(Boolean).join(" ");

  if (text.length <= TITLE_MAX_LENGTH) {
    return text || null;
  }

  let cut = text.slice(0, TITLE_MAX_LENGTH - TITLE_ELLIPSIS.length);
  const wordEnd = cut.lastIndexOf(" ");

  if (wordEnd >= Math.floor(TITLE_MAX_LENGTH / 2)) {
    cut = cut.slice(0, wordEnd);
  }

  return cut.replace(/[ ,.;:-]+$/, "") + TITLE_ELLIPSIS;
}
