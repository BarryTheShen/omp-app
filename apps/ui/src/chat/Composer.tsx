import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, memo, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
      className="px-4 pt-2 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        send("auto");
      }}
    >
      <div className="mx-auto flex max-w-[720px] items-end gap-2 rounded-xl border border-l2 bg-card py-2 pr-2 pl-3.5 focus-within:border-l4">
        <textarea
          className="max-h-[12lh] min-h-[1lh] flex-1 resize-none bg-transparent py-1 text-[0.875rem] leading-normal text-t1 outline-none [field-sizing:content] placeholder:text-t3"
          aria-label="Message"
          placeholder={disabled ? "Opening the chat…" : "Message omp"}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {working ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  aria-label="Stop"
                  onClick={() => void onStop()}
                />
              }
            >
              <Square className="fill-current" />
            </TooltipTrigger>
            <TooltipContent>Stop (Esc)</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="submit"
                  size="icon-sm"
                  aria-label="Send"
                  disabled={disabled || text.trim().length === 0}
                />
              }
            >
              <ArrowUp />
            </TooltipTrigger>
            <TooltipContent>Send (Enter)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </form>
  );
});
