import type { FormEvent, Ref } from "react";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  // Sending is blocked during a reply; typing ahead is not.
  sendBlocked: boolean;
  textareaRef: Ref<HTMLTextAreaElement>;
}

function Composer({
  value,
  onChange,
  onSubmit,
  sendBlocked,
  textareaRef,
}: ComposerProps) {
  return (
    <>
      <form className="composer" onSubmit={onSubmit}>
        {/*
          The textarea stays editable during a reply so the next message can
          be drafted; the submit handler blocks sending. Disabling it would
          also drop keyboard focus.
        */}
        <textarea
          ref={textareaRef}
          aria-label="Message"
          placeholder="Message Curibot..."
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
        />

        <div className="composer-footer">
          <span>Enter to send · Shift+Enter for a new line</span>

          <button
            type="submit"
            aria-label="Send message"
            disabled={!value.trim() || sendBlocked}
          >
            ↑
          </button>
        </div>
      </form>

      <p className="disclaimer">
        AI responses may be inaccurate. Verify important information.
      </p>
    </>
  );
}

export default Composer;
