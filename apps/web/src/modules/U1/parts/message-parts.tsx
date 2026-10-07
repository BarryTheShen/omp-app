import { type EnrichedPartState, MessagePrimitive, type MessageState } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { File } from "@/components/assistant-ui/elements/file";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";
import { cn } from "@/lib/utils";
import { MarkdownText } from "../markdown";
import { ReasoningGroup, reasoningGroupBy } from "../reasoning";
import { type ToolRendererMap, ToolSlot } from "../tool-slots";
export interface MessagePartsProps {
  readonly message: MessageState;
  readonly toolRenderers?: ToolRendererMap;
  readonly extra?: ReactNode;
}

export interface ImagePartProps {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
}

export interface FilePartProps {
  readonly name: string;
  readonly detail?: string;
  readonly className?: string;
}

export interface SourcePartProps {
  readonly title: string;
  readonly url?: string;
  readonly detail?: string;
  readonly className?: string;
}

/** Safe image presentation for a normalized image part; unsupported protocols become visible text. */
export function ImagePart({ src, alt, className }: ImagePartProps) {
  const safe =
    src.startsWith("data:image/") || src.startsWith("https://") || src.startsWith("http://");
  if (!safe) return <span className="text-muted-foreground text-sm">Image unavailable.</span>;
  return (
    <figure
      className={cn("my-2 max-w-full overflow-hidden rounded-lg", className)}
      data-part-type="image"
    >
      <img alt={alt} className="block max-h-96 max-w-full object-contain" src={src} />
    </figure>
  );
}

/** Compact file presentation; U1.4 owns richer media previews and byte policies. */
export function FilePart({ name, detail, className }: FilePartProps) {
  return (
    <div
      className={cn(
        "border-border bg-muted/40 my-2 rounded-md border px-3 py-2 text-sm",
        className,
      )}
      data-part-type="file"
    >
      <span className="font-medium">{name}</span>
      {detail !== undefined && <span className="text-muted-foreground ms-2">{detail}</span>}
    </div>
  );
}

/** Source links are rendered only for approved web protocols; all other sources remain safe text. */
export function SourcePart({ title, url, detail, className }: SourcePartProps) {
  const safe = url?.startsWith("https://") || url?.startsWith("http://");
  return (
    <div className={cn("my-2 text-sm", className)} data-part-type="source">
      {safe ? (
        <a
          className="text-primary underline underline-offset-2"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          {title}
        </a>
      ) : (
        <span>{title}</span>
      )}
      {detail !== undefined && <span className="text-muted-foreground ms-2">{detail}</span>}
    </div>
  );
}

function renderPart(
  part: EnrichedPartState,
  toolRenderers: ToolRendererMap | undefined,
): ReactNode {
  switch (part.type) {
    case "text":
      return <MarkdownText />;
    case "reasoning":
      return <Reasoning {...part} />;
    case "image":
      return <ImagePart alt="Image attachment" src={part.image} />;
    case "file":
      return <File {...part} />;
    case "tool-call":
      return <ToolSlot part={part} renderers={toolRenderers} />;
    case "data":
      return part.dataRendererUI;
    default:
      return (
        <span className="text-muted-foreground text-sm" data-part-type="unknown">
          Unable to render this message part.
        </span>
      );
  }
}

/** Renders one assistant-ui message with U1's role grammar and U3's tool boundary. */
export function MessageParts({ message, toolRenderers, extra }: MessagePartsProps) {
  const role = message.role;
  const isUser = role === "user";
  const isSystem = role === "system";
  const className = isUser
    ? "ms-auto max-w-[min(42rem,85%)] rounded-2xl bg-muted px-4 py-2.5"
    : isSystem
      ? "border-border bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm"
      : "w-full";

  return (
    <MessagePrimitive.Root
      className={cn(
        "mx-auto w-full max-w-(--layout-thread-width) px-6 py-3",
        isUser && "flex justify-end",
        isSystem && "py-2",
      )}
      data-message-id={message.id}
      data-role={role}
      data-slot="u1-message-row"
    >
      <div
        className={className}
        data-message-surface={isUser ? "user-bubble" : isSystem ? "system-note" : "assistant-text"}
      >
        <MessagePrimitive.GroupedParts groupBy={reasoningGroupBy} indicator="never">
          {({ part, children }) => {
            if (part.type === "group-reasoning")
              return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
            if (part.type === "indicator") return null;
            return renderPart(part as EnrichedPartState, toolRenderers);
          }}
        </MessagePrimitive.GroupedParts>
        {extra}
      </div>
    </MessagePrimitive.Root>
  );
}
