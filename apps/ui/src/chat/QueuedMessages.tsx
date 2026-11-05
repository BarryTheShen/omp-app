import { attachedSummary } from "@omp-app/contracts";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ChatQueue } from "./store";

/**
 * Messages waiting in omp's queues, one pill each: a steer goes in after the running step, a follow-up after the turn.
 * Edit takes one back into the message box.
 */
export function QueuedMessages({
  queue,
  onTakeBack,
}: {
  readonly queue: ChatQueue;
  readonly onTakeBack: (message: string, queue: "steering" | "followUp") => void;
}): ReactNode {
  const items = [
    ...queue.steering.map((message) => ({ message, queue: "steering" as const })),
    ...queue.followUp.map((message) => ({ message, queue: "followUp" as const })),
  ];
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 pb-2" aria-label="Queued messages">
      {items.map((item, index) => (
        <li
          // Two queued messages can have the same text; their order tells them apart.
          // biome-ignore lint/suspicious/noArrayIndexKey: the queue's order is the identity omp gives them
          key={`${item.queue}-${index}`}
          className="flex h-8 items-center gap-2 rounded-lg border border-l2 bg-raise pr-1 pl-3 text-xs"
        >
          <span className="shrink-0 text-t3">
            {item.queue === "steering" ? "Steer" : "Follow-up"}
          </span>
          <span className="min-w-0 flex-1 truncate text-t1">{attachedSummary(item.message)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Edit queued message"
            onClick={() => onTakeBack(item.message, item.queue)}
          >
            <Pencil />
          </Button>
        </li>
      ))}
    </ul>
  );
}
