import { attachedSummary, splitAppNotice } from "@omp-app/contracts";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ChatQueue } from "./store";

/**
 * Messages waiting in omp's queues, one pill each: a steer goes in after the running step, a follow-up after the turn.
 * A message's pictures show beside its words, small, named as in the transcript ("Image 1"). Edit takes one back into
 * the message box, pictures included. A notice (`splitAppNotice`: something other than you sent it) shows as one and
 * has no Edit: it is not yours to take into the box. Your answers from the Questions panel are yours: their Edit takes
 * them back to the panel, to change them there.
 */
export function QueuedMessages({
  queue,
  onTakeBack,
  onReopenAnswers,
}: {
  readonly queue: ChatQueue;
  readonly onTakeBack: (message: string, queue: "steering" | "followUp") => void;
  /** Your answers from the Questions panel, taken back to change them there (`reopen_answers`). */
  readonly onReopenAnswers: (message: string) => void;
}): ReactNode {
  const items = [
    ...queue.steering.map((message, index) => ({
      message,
      queue: "steering" as const,
      images: queue.images.steering[index] ?? [],
    })),
    ...queue.followUp.map((message, index) => ({
      message,
      queue: "followUp" as const,
      images: queue.images.followUp[index] ?? [],
    })),
  ];
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 pb-2" aria-label="Queued messages">
      {items.map((item, index) => {
        const notice = splitAppNotice(item.message);
        return (
          <li
            // Two queued messages can have the same text; their order tells them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: the queue's order is the identity omp gives them
            key={`${item.queue}-${index}`}
            className="flex h-8 items-center gap-2 rounded-lg border border-l2 bg-raise pr-1 pl-3 text-xs"
          >
            <span className="shrink-0 text-t3">
              {notice?.source === "questions"
                ? "Your answers"
                : notice !== null
                  ? "Notice"
                  : item.queue === "steering"
                    ? "Steer"
                    : "Follow-up"}
            </span>
            <span className="min-w-0 flex-1 truncate text-t1">
              {notice !== null ? notice.text : attachedSummary(item.message)}
            </span>
            {item.images.length > 0 && (
              <span className="flex shrink-0 gap-1">
                {item.images.map((image, at) => (
                  <img
                    // biome-ignore lint/suspicious/noArrayIndexKey: a message's pictures keep their order
                    key={at}
                    src={`data:${image.mimeType};base64,${image.data}`}
                    // biome-ignore lint/a11y/noRedundantAlt: the picture's name, as the text names it ([Image #1, WxH])
                    alt={`Image ${at + 1}`}
                    className="size-6 rounded-sm border border-l2 object-cover"
                  />
                ))}
              </span>
            )}
            {notice === null && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit queued message"
                onClick={() => onTakeBack(item.message, item.queue)}
              >
                <Pencil />
              </Button>
            )}
            {notice?.source === "questions" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit your answers"
                onClick={() => onReopenAnswers(item.message)}
              >
                <Pencil />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
