import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { Check, Copy, Pencil } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** The text of one of your messages; null for every other entry. */
export function userText(entry: SessionEntry): string | null {
  if (entry.type !== "message" || entry.message.role !== "user") return null;
  const { content } = entry.message;
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

/**
 * Copy and Edit under one of your messages, shown while the pointer is on it (always on a touch screen). Edit is
 * offered once omp has saved the message and while omp is idle; null hides it.
 */
export function MessageActions({
  text,
  onEdit,
}: {
  readonly text: string;
  readonly onEdit: (() => void) | null;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="tr-row tr-row--actions">
      <div className="tr-body opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-t3 hover:text-t1"
          aria-label={copied ? "Copied" : "Copy this message"}
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        {onEdit !== null && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-t3 hover:text-t1"
            aria-label="Edit this message"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        )}
      </div>
    </div>
  );
}
