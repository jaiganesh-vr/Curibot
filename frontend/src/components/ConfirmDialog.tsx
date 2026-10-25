import { useEffect, useId, useRef, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A modal confirmation for destructive actions.
 *
 * Built on the native <dialog> element: showModal() traps focus, makes the
 * rest of the page inert, renders above everything (including the mobile
 * drawer), and restores focus to the previously focused control on close.
 * The `open` prop stays the source of truth, so Escape and backdrop clicks
 * are routed through onCancel instead of closing the dialog directly.
 */
function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
      // Start on Cancel so pressing Enter never deletes by accident.
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          onCancel();
        }
      }}
      onClick={(event) => {
        // Clicks on the backdrop target the dialog element itself.
        if (event.target === event.currentTarget && !busy) {
          onCancel();
        }
      }}
    >
      <div className="confirm-dialog-body">
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{children}</p>

        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            className="dialog-button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="dialog-button dialog-button-danger"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export default ConfirmDialog;
