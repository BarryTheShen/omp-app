import {
  type Attachment,
  AttachmentPrimitive,
  type CompleteAttachment,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { XIcon } from "lucide-react";
import { type FC, useMemo, useSyncExternalStore } from "react";
import { InlineError } from "@/components/blocks";
import { Button } from "../../../components/ui/button";
import type { AttachmentAdapter } from "../contract";

/** The look of an attachment chip: the composer's chips and the transcript's pasted-text chips share it. */
export const ATTACHMENT_CHIP_CLASS =
  "border-foreground/10 bg-muted/30 flex min-w-0 items-center gap-(--space-xs) rounded-surface border px-(--space-sm) py-(--space-2xs)";

const EMPTY_ATTACHMENT_STATE = Object.freeze({
  pending: [],
  complete: [],
  error: null,
  removeFailure: null,
});

export interface AttachmentChipsProps {
  readonly manager?: AttachmentAdapter;
}

function ManagerAttachmentChip({
  attachment,
  onRemove,
}: {
  readonly attachment: CompleteAttachment;
  readonly onRemove: (attachment: CompleteAttachment) => void;
}) {
  const image = attachment.content.find((part) => part.type === "image");
  return (
    <div data-slot="attachment-root" className={ATTACHMENT_CHIP_CLASS}>
      {image?.type === "image" && (
        <img src={image.image} alt="" className="size-6 rounded-sm object-cover" />
      )}
      <span className="min-w-0 max-w-48 truncate text-sm">{attachment.name}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${attachment.name}`}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded-full"
        onClick={() => onRemove(attachment)}
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
  // The manager keeps the reason a removal was refused, so the chips show it even when they are shown again. The
  // rejection is handled here, and the message comes from the manager's state.
  const remove = (attachment: Attachment): void => {
    if (manager === undefined) return;
    void manager.remove(attachment).catch(() => undefined);
  };
  return (
    <>
      <div
        data-slot="u2-composer-attachments"
        className="flex w-full flex-row items-center gap-(--space-xs) overflow-x-auto px-2 pb-2 empty:hidden"
      >
        {manager ? (
          <>
            {managerState.pending.map((attachment) => (
              <div
                key={attachment.id}
                data-slot="attachment-root"
                className={`${ATTACHMENT_CHIP_CLASS} opacity-70`}
              >
                <span className="min-w-0 max-w-48 truncate text-sm">{attachment.name}</span>
                {attachment.status.type === "incomplete" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${attachment.name}`}
                    className="text-muted-foreground hover:text-foreground shrink-0 rounded-full"
                    onClick={() => remove(attachment)}
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </Button>
                )}
              </div>
            ))}
            {managerState.complete.map((attachment) => (
              <ManagerAttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={remove}
              />
            ))}
          </>
        ) : (
          <ComposerPrimitive.Attachments>
            {() => (
              <AttachmentPrimitive.Root className={ATTACHMENT_CHIP_CLASS}>
                <AttachmentPrimitive.unstable_Thumb />
                <span className="min-w-0 max-w-48 truncate text-sm">
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
      {managerState.removeFailure !== null && (
        <InlineError message={managerState.removeFailure} variant="message" />
      )}
    </>
  );
};
