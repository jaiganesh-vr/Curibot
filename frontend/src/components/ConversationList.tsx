import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../api/client";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  // Deleting is blocked for a conversation whose reply is still streaming.
  deleteDisabledId: string | null;
  onSelect: (conversationId: string) => void;
  // Called with a trimmed, changed, non-empty title.
  onRename: (conversation: Conversation, title: string) => void;
  // The trigger is the options button, which receives focus back later.
  onRequestDelete: (
    conversation: Conversation,
    trigger: HTMLButtonElement | null,
  ) => void;
  // True while an options menu or rename box is open, so the drawer can
  // let them handle Escape first.
  onBusyChange: (busy: boolean) => void;
}

/** The sidebar list, with each conversation's options menu and rename box. */
function ConversationList({
  conversations,
  selectedId,
  deleteDisabledId,
  onSelect,
  onRename,
  onRequestDelete,
  onBusyChange,
}: ConversationListProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Enter, Escape, and blur can all end a rename; only the first one counts.
  const renameFinishedRef = useRef(false);

  const busy = openMenuId !== null || renamingId !== null;

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // Close the options menu on an outside click or Escape.
  useEffect(() => {
    if (openMenuId === null) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-conversation-menu]")
      ) {
        setOpenMenuId(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenuId(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenuId]);

  function startRename(conversation: Conversation) {
    renameFinishedRef.current = false;
    setOpenMenuId(null);
    setRenameDraft(conversation.title ?? "");
    setRenamingId(conversation.id);
  }

  function cancelRename() {
    renameFinishedRef.current = true;
    setRenamingId(null);
  }

  function finishRename(conversation: Conversation) {
    if (renameFinishedRef.current) {
      return;
    }

    renameFinishedRef.current = true;
    setRenamingId(null);

    const title = renameDraft.trim();

    if (title && title !== conversation.title) {
      onRename(conversation, title);
    }
  }

  return (
    <ul className="conversation-list">
      {conversations.map((conversation) => {
        const title = conversation.title || "New conversation";
        const menuOpen = openMenuId === conversation.id;
        const selected = conversation.id === selectedId;

        return (
          <li
            key={conversation.id}
            className={menuOpen ? "conversation-row-menu-open" : undefined}
          >
            {renamingId === conversation.id ? (
              <form
                className="conversation-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  finishRename(conversation);
                }}
              >
                <input
                  aria-label="Conversation title"
                  value={renameDraft}
                  maxLength={200}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => finishRename(conversation)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelRename();
                    }
                  }}
                />
              </form>
            ) : (
              <>
                <button
                  className={`conversation-item ${selected ? "conversation-item-active" : ""}`}
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
                    onSelect(conversation.id);
                  }}
                  aria-current={selected ? "page" : undefined}
                >
                  {title}
                </button>

                <div className="conversation-actions" data-conversation-menu>
                  <button
                    className="conversation-menu-button"
                    type="button"
                    aria-label={`Options for ${title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() =>
                      setOpenMenuId(menuOpen ? null : conversation.id)
                    }
                  >
                    <span className="conversation-menu-dot" />
                    <span className="conversation-menu-dot" />
                    <span className="conversation-menu-dot" />
                  </button>

                  {menuOpen && (
                    <div className="conversation-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => startRename(conversation)}
                      >
                        Rename
                      </button>
                      <button
                        className="conversation-menu-danger"
                        type="button"
                        role="menuitem"
                        disabled={conversation.id === deleteDisabledId}
                        onClick={(event) => {
                          const trigger =
                            event.currentTarget
                              .closest("[data-conversation-menu]")
                              ?.querySelector<HTMLButtonElement>(
                                ".conversation-menu-button",
                              ) ?? null;

                          setOpenMenuId(null);
                          onRequestDelete(conversation, trigger);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default ConversationList;
