import { TextMessagePartProvider } from "@assistant-ui/react";
import { splitPastedBlocks } from "@omp-app/contracts";
import { useMemo } from "react";
import { ATTACHMENT_CHIP_CLASS, pastedTextName } from "@/modules/U2/attachments";
import { MarkdownText } from "../markdown";

/** A pasted block in a sent message: one chip, named as the composer's chip is. It is display only. */
function PastedTextChip({ name }: { readonly name: string }) {
  return (
    <div className={ATTACHMENT_CHIP_CLASS} data-part-type="pasted-text">
      <span className="min-w-0 max-w-48 truncate text-xs">{name}</span>
    </div>
  );
}

/** Whether a person's text holds a pasted block, so the transcript shows its chips. */
export function hasPastedBlock(text: string): boolean {
  return splitPastedBlocks(text).some((segment) => segment.kind === "pasted");
}

/**
 * A person's text with each pasted block shown as a chip, in the order the blocks were written. The text itself is not
 * changed: copy and edit still get the whole message.
 */
export function PastedBlockText({ text }: { readonly text: string }) {
  const segments = useMemo(() => splitPastedBlocks(text), [text]);
  return (
    <div className="flex min-w-0 flex-col gap-(--space-xs)" data-part-type="user-text">
      {segments.map((segment) =>
        segment.kind === "text" ? (
          <TextMessagePartProvider key={segment.start} text={segment.text}>
            <MarkdownText lineBreaks />
          </TextMessagePartProvider>
        ) : (
          <PastedTextChip
            key={segment.start}
            name={pastedTextName(segment.sequence, segment.lines)}
          />
        ),
      )}
    </div>
  );
}
