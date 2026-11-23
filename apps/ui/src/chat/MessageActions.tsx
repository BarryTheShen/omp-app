import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { splitAppNotice } from "@omp-app/contracts";
import { Check, Copy, Pencil } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { writeClipboard } from "../clipboard";
import { useLongPress } from "../longPress";
import { usePhone } from "../phone";

/**
 * The text of one of your messages; null for every other entry, notices included: a message something else put into
 * the chat (`splitAppNotice`) is not yours to copy, edit, recall with Up or name the chat by.
 */
export function userText(entry: SessionEntry): string | null {
  if (entry.type !== "message" || entry.message.role !== "user") return null;
  const { content } = entry.message;
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim();
  return splitAppNotice(text) === null ? text : null;
}

/**
 * Your answers from the Questions panel as the chat holds them (a `questions` notice): the whole message, which the host
 * matches to take them back, and their words, for Copy. Null for any other entry.
 */
export function answersNotice(
  entry: SessionEntry,
): { readonly message: string; readonly text: string } | null {
  if (entry.type !== "message" || entry.message.role !== "user") return null;
  const { content } = entry.message;
  const message =
    typeof content === "string"
      ? content
      : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  const notice = splitAppNotice(message.trim());
  return notice?.source === "questions" ? { message: message.trim(), text: notice.text } : null;
}

/**
 * One of your messages with Copy and Edit. On a computer they are under it, shown while the pointer is on it; on a phone
 * a touch-and-hold on the message opens them (a sheet, #2770), as a chat's row in the list does. Edit is offered once
 * omp has saved the message and while omp is idle; null hides it. `editLabel` names Edit (your answers' Edit takes them
 * back to the Questions panel).
 */
export function MessageActions({
  text,
  onEdit,
  editLabel = "Edit this message",
  children,
}: {
  readonly text: string;
  readonly onEdit: (() => void) | null;
  readonly editLabel?: string;
  /** The message itself. */
  readonly children: ReactNode;
}): ReactNode {
  const phone = usePhone();
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { endsHold: _endsHold, ...hold } = useLongPress(() => setMenuOpen(true));
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (): void => {
    void writeClipboard(text).then(() => setCopied(true));
  };
  if (phone) {
    return (
      // The hold opens the menu, not the phone's own text selection and its callout. `tl-hold`: the transcript's row
      // rules reach the message through this box (index.css). The menu's trigger is out of the flow: a phone's
      // 44 px rule for buttons (index.css) made it a 44 px block under every message of yours.
      <div {...hold} className="tl-hold relative select-none [-webkit-touch-callout:none]">
        {children}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            aria-label="Message actions"
            className="pointer-events-none absolute right-0 bottom-0 block size-px opacity-0"
          />
          <DropdownMenuContent>
            <DropdownMenuItem onClick={copy}>
              <Copy />
              Copy
            </DropdownMenuItem>
            {onEdit !== null && (
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                Edit
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
  return (
    <>
      {children}
      <div className="tr-row tr-row--actions">
        <div className="tr-body opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-t3 hover:text-t1 tablet:size-11"
            aria-label={copied ? "Copied" : "Copy this message"}
            onClick={copy}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          {onEdit !== null && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-t3 hover:text-t1 tablet:size-11"
              aria-label={editLabel}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
