import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import {
  ApiError,
  clearMemories,
  deleteMemory,
  listMemories,
  type Memory,
} from "../api/client";
import { getStoredToken } from "../lib/session";

interface MemoryPanelProps {
  open: boolean;
  onClose: () => void;
  // Called when a request is rejected with 401, i.e. the session expired.
  onSessionExpired: () => void;
}

/**
 * A modal listing what the assistant remembers about the user, where each
 * memory can be forgotten or all of them cleared.
 *
 * Built on the native <dialog> element, like ConfirmDialog, for focus
 * trapping and page inertness.
 */
function MemoryPanel({ open, onClose, onSessionExpired }: MemoryPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [busy, setBusy] = useState(false);

  // Returns true when the failure was an expired session.
  function handleFailure(err: unknown, fallback: string): boolean {
    if (err instanceof ApiError && err.status === 401) {
      onSessionExpired();
      return true;
    }
    setError(err instanceof ApiError ? err.message : fallback);
    return false;
  }

  const onLoadFailure = useEffectEvent((err: unknown) =>
    handleFailure(err, "Unable to load memories."),
  );

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Load fresh memories each time the panel opens; a chat turn may have
  // added or removed some since last time.
  useEffect(() => {
    const token = getStoredToken();

    if (!open || !token) {
      return;
    }

    let cancelled = false;

    async function load(storedToken: string) {
      setLoading(true);
      setError("");
      setConfirmingClear(false);

      try {
        const saved = await listMemories(storedToken);

        if (!cancelled) {
          setMemories(saved);
        }
      } catch (err) {
        if (!cancelled) {
          onLoadFailure(err);
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
  }, [open]);

  async function handleForget(memory: Memory) {
    const token = getStoredToken();

    if (!token) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await deleteMemory(token, memory.id);
      setMemories((current) => current.filter((item) => item.id !== memory.id));
    } catch (err) {
      handleFailure(err, "Unable to forget that memory.");
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAll() {
    const token = getStoredToken();

    if (!token) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await clearMemories(token);
      setMemories([]);
      setConfirmingClear(false);
      closeRef.current?.focus();
    } catch (err) {
      handleFailure(err, "Unable to clear memories.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="memory-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (confirmingClear) {
          setConfirmingClear(false);
        } else {
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="memory-dialog-body">
        <div className="memory-dialog-header">
          <h2 id={titleId}>What Curibot remembers</h2>
          <button
            ref={closeRef}
            className="memory-close"
            type="button"
            aria-label="Close memory"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <p className="memory-intro">
          Curibot uses these facts in every conversation. Tell it something
          about yourself, or say “remember that…”, to add more.
        </p>

        {error && (
          <p className="auth-message auth-error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="memory-empty">Loading…</p>
        ) : memories.length === 0 ? (
          <p className="memory-empty">Curibot hasn't remembered anything yet.</p>
        ) : (
          <ul className="memory-list">
            {memories.map((memory) => (
              <li key={memory.id}>
                <span>{memory.content}</span>
                <button
                  className="memory-forget"
                  type="button"
                  aria-label={`Forget “${memory.content}”`}
                  disabled={busy}
                  onClick={() => void handleForget(memory)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {memories.length > 0 && !loading && (
          <div className="memory-actions">
            {confirmingClear ? (
              <>
                <span className="memory-confirm-text">
                  Forget all {memories.length} memories?
                </span>
                <button
                  className="dialog-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingClear(false)}
                >
                  Cancel
                </button>
                <button
                  className="dialog-button dialog-button-danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleClearAll()}
                >
                  {busy ? "Clearing…" : "Clear all"}
                </button>
              </>
            ) : (
              <button
                className="dialog-button"
                type="button"
                disabled={busy}
                onClick={() => setConfirmingClear(true)}
              >
                Clear all…
              </button>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}

export default MemoryPanel;
