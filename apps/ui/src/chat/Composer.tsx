import { type KeyboardEvent, memo, type ReactNode, useState } from "react";

/**
 * The message box (V1: text only). Enter sends; while omp works, Enter steers and Ctrl+Enter queues a follow-up;
 * Shift+Enter or Alt+Enter adds a line; Esc stops omp.
 */
export const Composer = memo(function Composer({
  working,
  disabled,
  onSend,
  onStop,
}: {
  readonly working: boolean;
  readonly disabled: boolean;
  readonly onSend: (text: string, mode: "auto" | "followUp") => Promise<void>;
  readonly onStop: () => Promise<void>;
}): ReactNode {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = (mode: "auto" | "followUp"): void => {
    const value = text.trim();
    if (value.length === 0 || disabled || sending) return;
    setSending(true);
    onSend(value, mode)
      .then(() => setText(""))
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && working) {
      event.preventDefault();
      void onStop();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    send(event.ctrlKey || event.metaKey ? "followUp" : "auto");
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send("auto");
      }}
    >
      <textarea
        className="composer-input"
        aria-label="Message"
        placeholder={disabled ? "Opening the chat…" : "Message omp"}
        value={text}
        rows={1}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {working ? (
        <button type="button" className="composer-button" onClick={() => void onStop()}>
          Stop
        </button>
      ) : (
        <button
          type="submit"
          className="composer-button"
          disabled={disabled || text.trim().length === 0}
        >
          Send
        </button>
      )}
    </form>
  );
});
