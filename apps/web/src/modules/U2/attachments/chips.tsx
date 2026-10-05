import {
  AttachmentPrimitive,
  type CompleteAttachment,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { XIcon } from "lucide-react";
import { type FC, useMemo, useSyncExternalStore } from "react";
import { Button } from "../../../components/ui/button";
import type { AttachmentAdapter } from "../contract";

const EMPTY_ATTACHMENT_STATE = Object.freeze({
  pending: [],
  complete: [],
  error: null,
});

export interface AttachmentChipsProps {
  readonly manager?: AttachmentAdapter;
}

function ManagerAttachmentChip({
  attachment,
  manager,
}: {
  readonly attachment: CompleteAttachment;
  readonly manager: AttachmentAdapter;
}) {
  const image = attachment.content.find((part) => part.type === "image");
  return (
    <div
      data-slot="attachment-root"
      className="border-border bg-card shadow-xs flex min-w-0 items-center gap-(--space-xs) rounded-(--radius) border px-(--space-sm) py-(--space-2xs)"
    >
      {image?.type === "image" && (
        <img src={image.image} alt="" className="size-6 rounded-sm object-cover" />
      )}
      <span className="min-w-0 max-w-48 truncate text-xs">{attachment.name}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${attachment.name}`}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded-full"
        onClick={() => void manager.remove(attachment)}
      >
        <XIcon aria-hidden="true" className="size-3" />
      </Button>
    </div>
  );
}

/** U2's token-based attachment chip; remove/thumbnail behavior stays in assistant-ui primitives. */
export const AttachmentChips: FC<AttachmentChipsProps> = ({ manager }) => {
  const subscribe = useMemo(
    () => manager?.subscribe.bind(manager) ?? (() => () => undefined),
    [manager],
  );
  const getSnapshot = useMemo(
    () => manager?.getState.bind(manager) ?? (() => EMPTY_ATTACHMENT_STATE),
    [manager],
  );
  const managerState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <div
      data-slot="u2-composer-attachments"
      className="flex w-full flex-row items-center gap-(--space-xs) overflow-x-auto empty:hidden"
    >
      {manager ? (
        <>
          {managerState.pending.map((attachment) => (
            <div
              key={attachment.id}
              data-slot="attachment-root"
              className="border-border bg-card shadow-xs flex min-w-0 items-center gap-(--space-xs) rounded-(--radius) border px-(--space-sm) py-(--space-2xs) opacity-70"
            >
              <span className="min-w-0 max-w-48 truncate text-xs">{attachment.name}</span>
            </div>
          ))}
          {managerState.complete.map((attachment) => (
            <ManagerAttachmentChip key={attachment.id} attachment={attachment} manager={manager} />
          ))}
        </>
      ) : (
        <ComposerPrimitive.Attachments>
          {() => (
            <AttachmentPrimitive.Root className="border-border bg-card shadow-xs flex min-w-0 items-center gap-(--space-xs) rounded-(--radius) border px-(--space-sm) py-(--space-2xs)">
              <AttachmentPrimitive.unstable_Thumb />
              <span className="min-w-0 max-w-48 truncate text-xs">
                <AttachmentPrimitive.Name />
              </span>
              <AttachmentPrimitive.Remove
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove attachment"
                    className="text-muted-foreground hover:text-foreground shrink-0 rounded-full"
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </Button>
                }
              />
            </AttachmentPrimitive.Root>
          )}
        </ComposerPrimitive.Attachments>
      )}
    </div>
  );
};
