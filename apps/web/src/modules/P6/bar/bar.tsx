import { ArrowUpIcon, XIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../../components/ui/button";
import {
  P6_QUEUE_CAPABILITIES,
  type QueueAdapterController,
  type QueueAdapterSnapshot,
  type QueueItemView,
} from "../contract";

export type QueueConnectionState = "connected" | "connecting" | "reconnecting" | "closed";

export interface QueueLaneBarProps {
  readonly controller: QueueAdapterController;
  readonly connection?: {
    readonly state: QueueConnectionState;
    readonly reason?: string;
  };
}

function LaneItem({
  item,
  disabled,
  disabledReason,
  onRemove,
  onPromote,
}: {
  readonly item: QueueItemView;
  readonly disabled: boolean;
  readonly disabledReason: string;
  readonly onRemove: () => void;
  readonly onPromote?: () => void;
}) {
  const removeLabel = `Remove ${item.lane === "steering" ? "steering" : "follow-up"} message: ${item.prompt}`;
  return (
    <li
      className="border-foreground/10 bg-background flex min-w-0 items-center gap-(--space-xs) rounded-control border px-(--space-sm) py-(--space-xs)"
      data-queue-item-id={item.id}
      data-queue-lane={item.lane}
      data-queue-status={item.status}
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm" title={item.prompt}>
        {item.prompt}
      </span>
      {onPromote && (
        <Button
          aria-label={`Promote queued message: ${item.prompt}`}
          className="shrink-0"
          disabled={disabled}
          size="icon-sm"
          title={disabled ? disabledReason : "Send as steering at the next tool boundary"}
          type="button"
          variant="ghost"
          onClick={onPromote}
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
      )}
      {item.status === "sent" ? (
        <span className="text-muted-foreground flex h-7 shrink-0 items-center text-xs">Sent</span>
      ) : (
        <Button
          aria-label={removeLabel}
          className="shrink-0"
          disabled={disabled || !item.canRemove}
          size="icon-sm"
          title={
            disabled
              ? disabledReason
              : item.canRemove
                ? "Remove queued message"
                : "Removing queued messages is unavailable"
          }
          type="button"
          variant="ghost"
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

function Lane({
  label,
  items,
  disabled,
  disabledReason,
  onRemove,
  onPromote,
}: {
  readonly label: string;
  readonly items: readonly QueueItemView[];
  readonly disabled: boolean;
  readonly disabledReason: string;
  readonly onRemove: (item: QueueItemView) => void;
  readonly onPromote?: (item: QueueItemView) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label} className="min-w-0 space-y-(--space-xs)" data-queue-lane={label}>
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</h2>
      <ol className="m-0 flex min-w-0 flex-col gap-(--space-xs) p-0">
        {items.map((item) => (
          <LaneItem
            key={item.id}
            disabled={disabled}
            disabledReason={disabledReason}
            item={item}
            onPromote={onPromote ? () => onPromote(item) : undefined}
            onRemove={() => onRemove(item)}
          />
        ))}
      </ol>
    </section>
  );
}

function connectionReason(state: QueueConnectionState, reason?: string): string {
  if (reason) return reason;
  if (state === "reconnecting") return "Reconnecting to the app server; queue actions are paused.";
  if (state === "connecting") return "Connecting to the app server; queue actions are paused.";
  if (state === "closed") return "The app server is unavailable; queue actions are paused.";
  return "Queue actions are unavailable.";
}

export function QueueLaneBar({
  controller,
  connection = { state: "connected" },
}: QueueLaneBarProps) {
  const [snapshot, setSnapshot] = useState<QueueAdapterSnapshot>(() => controller.getSnapshot());
  useEffect(() => {
    // Read the snapshot again on subscribe: a change between the first render and here is not lost.
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);
  if (snapshot.items.length === 0 && snapshot.steerItems.length === 0) return null;

  const disconnected = connection.state !== "connected";
  const disabledReason = connectionReason(connection.state, connection.reason);
  const canPromote = snapshot.capabilities[P6_QUEUE_CAPABILITIES.promote]?.state === "available";
  const onRemove = (item: QueueItemView): void => controller.adapter.remove(item.id);
  const onPromote = (item: QueueItemView): void =>
    controller.adapter.move(item.id, { lane: "steer" });

  return (
    <aside
      aria-label="Queued messages"
      className="border-foreground/10 bg-muted/30 mb-(--space-xs) flex w-full flex-col gap-(--space-md) rounded-surface border p-(--space-sm) text-sm"
      data-queue-bar="true"
      data-queue-connection={connection.state}
    >
      {disconnected && (
        <p
          aria-live="polite"
          className="text-warning text-sm"
          data-queue-disabled-reason
          role="status"
        >
          {disabledReason}
        </p>
      )}
      {snapshot.lastError && (
        <p aria-live="assertive" className="text-destructive text-sm" data-queue-error role="alert">
          {snapshot.lastError.appError.message}
        </p>
      )}
      <div className="grid min-w-0 gap-(--space-md) sm:grid-cols-2">
        <Lane
          disabled={disconnected}
          disabledReason={disabledReason}
          items={snapshot.steerItems}
          label="Steering"
          onRemove={onRemove}
        />
        <Lane
          disabled={disconnected}
          disabledReason={disabledReason}
          items={snapshot.items}
          label="After this turn"
          onPromote={canPromote ? onPromote : undefined}
          onRemove={onRemove}
        />
      </div>
    </aside>
  );
}

/**
 * Whether a message waits in the queue. The queue's row in the composer is open only then, so an empty queue takes no
 * space, and the row follows the queue as it fills and empties.
 */
export function useQueueOpen(controller: QueueAdapterController): boolean {
  const waiting = () => {
    const snapshot = controller.getSnapshot();
    return snapshot.items.length > 0 || snapshot.steerItems.length > 0;
  };
  return useSyncExternalStore((listener) => controller.subscribe(listener), waiting, waiting);
}
