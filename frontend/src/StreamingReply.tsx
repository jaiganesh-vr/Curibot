import { useEffect, useRef, useState } from "react";
import MarkdownMessage from "./MarkdownMessage";

// Reveal a frame's share of the backlog: the pace rises as text piles up,
// so a burst from the model catches up in roughly this many frames.
const CATCH_UP_FRAMES = 18;
// Extend a step to the end of the current word if it is this close.
const WORD_SNAP_CHARS = 12;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function nextRevealLength(text: string, shown: number): number {
  const backlog = text.length - shown;
  const target = shown + Math.max(1, Math.ceil(backlog / CATCH_UP_FRAMES));

  if (target >= text.length) {
    return text.length;
  }

  // Ending on a word boundary avoids flashing half-typed Markdown like "**bo".
  const wordEnd = text.slice(target).search(/\s/);

  return wordEnd !== -1 && wordEnd <= WORD_SNAP_CHARS
    ? target + wordEnd
    : target;
}

interface StreamingReplyProps {
  text: string;
  // True once the server has sent the whole reply.
  complete: boolean;
  // Called once, after the complete reply is fully revealed.
  onRevealed: () => void;
  // Called whenever more text appears, so the view can follow it.
  onGrow: () => void;
}

/**
 * Show a streaming reply at a steady pace instead of in network bursts.
 *
 * Incoming text is buffered and revealed a little on every animation frame.
 */
function StreamingReply({
  text,
  complete,
  onRevealed,
  onGrow,
}: StreamingReplyProps) {
  const [shown, setShown] = useState(0);
  const revealedRef = useRef(false);
  const instant =
    typeof requestAnimationFrame !== "function" || prefersReducedMotion();
  const visibleLength = instant ? text.length : Math.min(shown, text.length);

  useEffect(() => {
    if (instant || shown >= text.length) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      setShown((current) => nextRevealLength(text, current));
    });

    return () => cancelAnimationFrame(frame);
  }, [instant, shown, text]);

  useEffect(() => {
    onGrow();
  }, [visibleLength, onGrow]);

  useEffect(() => {
    if (complete && visibleLength >= text.length && !revealedRef.current) {
      revealedRef.current = true;
      onRevealed();
    }
  }, [complete, visibleLength, text.length, onRevealed]);

  const visibleText = text.slice(0, visibleLength);

  return (
    <article
      className={`message message-assistant ${visibleText ? "message-streaming" : ""}`}
      aria-busy="true"
    >
      <div className="message-avatar">C</div>
      <div className="message-body">
        <p className="message-role">Assistant</p>
        {visibleText ? (
          <MarkdownMessage content={visibleText} />
        ) : (
          <p className="message-text message-thinking">Thinking...</p>
        )}
      </div>
    </article>
  );
}

export default StreamingReply;
