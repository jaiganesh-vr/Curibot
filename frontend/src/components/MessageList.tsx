import type { Message } from "../api/client";
import type { PendingTurn } from "../types";
import MarkdownMessage from "./MarkdownMessage";
import StreamingReply from "./StreamingReply";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  // The in-flight turn for this conversation, if any.
  pendingTurn: PendingTurn | null;
  onReplyRevealed: () => void;
  onReplyGrow: () => void;
}

function MessageList({
  messages,
  loading,
  pendingTurn,
  onReplyRevealed,
  onReplyGrow,
}: MessageListProps) {
  return (
    <div className="conversation-view">
      <div className="message-list" aria-live="polite">
        {loading ? (
          <p className="chat-status">Loading messages...</p>
        ) : messages.length === 0 && !pendingTurn ? (
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
                  {message.role === "user" ? "You" : "Assistant"}
                </p>
                {message.role === "assistant" ? (
                  <MarkdownMessage content={message.content} />
                ) : (
                  <p className="message-text">{message.content}</p>
                )}
              </div>
            </article>
          ))
        )}

        {pendingTurn && (
          <>
            <article className="message message-user">
              <div className="message-avatar">Y</div>
              <div className="message-body">
                <p className="message-role">You</p>
                <p className="message-text">{pendingTurn.userContent}</p>
              </div>
            </article>

            <StreamingReply
              text={pendingTurn.reply}
              complete={pendingTurn.savedTurn !== null}
              onRevealed={onReplyRevealed}
              onGrow={onReplyGrow}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default MessageList;
