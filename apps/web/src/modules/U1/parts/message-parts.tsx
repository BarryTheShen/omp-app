import { type EnrichedPartState, MessagePrimitive, type MessageState } from "@assistant-ui/react";
import { type ReactNode, useState } from "react";
import { File } from "@/components/assistant-ui/elements/file";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";
import { ENTER_FADE, isRecent } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { executionRecordOf } from "@/modules/U2/execution";
import { MarkdownText } from "../markdown";
import { ReasoningGroup } from "../reasoning";
import { type FileMention, FileMentionRow } from "../rows";
import { type ToolRendererMap, ToolSlot } from "../tool-slots";
import { CustomNote, type CustomNoteSource } from "./custom-note";
import { EarlierSteps, isTurnGroup, useTurnGroupBy } from "./earlier-steps";
import { ExecutionRow } from "./execution-row";
import { fileMentionFilesOf } from "./file-mention";
import { endingOf, MessageEndingNote } from "./message-ending";
import { hasPastedBlock, PastedBlockText } from "./pasted-text";
import { storeKeyOf } from "./store-key";
export interface MessagePartsProps {
  readonly message: MessageState;
  readonly toolRenderers?: ToolRendererMap;
  readonly extra?: ReactNode;
  /** Controls drawn under the bubble, inside the row: the edit and regenerate actions. */
  readonly actions?: ReactNode;
  /** Use compact rows and let each tool call place its nested transcript directly below the card. */
  readonly nested?: boolean;
  readonly renderNested?: (
    part: Extract<EnrichedPartState, { readonly type: "tool-call" }>,
  ) => ReactNode;
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
  renderNested: MessagePartsProps["renderNested"],
  /** A person's own message keeps the line breaks it was typed with. */
  lineBreaks: boolean,
): ReactNode {
  switch (part.type) {
    case "text":
      // A person's own text shows its pasted blocks as chips; any other text is Markdown, as before.
      return lineBreaks && hasPastedBlock(part.text) ? (
        <PastedBlockText text={part.text} />
      ) : (
        <MarkdownText lineBreaks={lineBreaks} />
      );
    case "reasoning":
      return <Reasoning {...part} />;
    case "image":
      return <ImagePart alt="Image attachment" src={part.image} />;
    case "file":
      return <File {...part} />;
    case "tool-call": {
      const tool = <ToolSlot part={part} renderers={toolRenderers} />;
      const nested = renderNested?.(part);
      return nested === undefined ? (
        tool
      ) : (
        <div
          className="w-full min-w-0"
          data-nested-tool-call-id={part.toolCallId}
          data-slot="u1-nested-tool-call"
        >
          {tool}
          {nested}
        </div>
      );
    }
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

/**
 * Whether a message has something to show. A turn's placeholder row is empty until its message replaces it: only the
 * message that arrives with content fades in, so the reader sees one fade, not a placeholder's and then the message's.
 */
function hasContent(message: MessageState): boolean {
  return message.content.some((part) => part.type !== "text" || part.text.trim() !== "");
}

/** One of omp's own messages (R0 marks it with its kind and details), or undefined for an ordinary one. */
function customNoteOf(message: MessageState): CustomNoteSource | undefined {
  const { ompCustomType, ompCustomDetails } = message.metadata.custom;
  if (typeof ompCustomType !== "string") return undefined;
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") texts.push(part.text);
  }
  return { customType: ompCustomType, details: ompCustomDetails, text: texts.join("\n\n") };
}

/** A user's own `!` or `$` run: R0 keeps omp's record in the metadata; U2 normalizes it. */
function executionOf(message: MessageState) {
  const raw: unknown = message.metadata.custom.ompExecution;
  return raw === undefined ? undefined : executionRecordOf(storeKeyOf(message), raw);
}

/** The file rows of one of omp's file mentions: R0 keeps omp's message in the metadata; undefined for any other message. */
function fileMentionOf(message: MessageState): readonly FileMention[] | undefined {
  const raw: unknown = message.metadata.custom.ompFileMention;
  return raw === undefined ? undefined : fileMentionFilesOf(raw);
}

/** Renders one assistant-ui message with U1's role grammar and U3's tool boundary. */
export function MessageParts({
  message,
  toolRenderers,
  extra,
  actions,
  nested = false,
  renderNested,
}: MessagePartsProps) {
  const role = message.role;
  const isUser = role === "user";
  const isSystem = role === "system";
  // A message that arrived just now fades in once. The state is read on the first render only, so a history that loads, or a reload, never fades.
  const [fresh] = useState(() => isRecent(message.createdAt?.getTime()) && hasContent(message));
  const note = isSystem ? customNoteOf(message) : undefined;
  const execution = isSystem ? executionOf(message) : undefined;
  const files = isSystem ? fileMentionOf(message) : undefined;
  const ending = endingOf(message);
  // A very long assistant turn folds its earlier steps away (see earlier-steps.tsx).
  const groupBy = useTurnGroupBy(!isUser && !isSystem);
  const className = isUser
    ? nested
      ? "ms-auto min-w-0 max-w-full rounded-2xl bg-muted px-3 py-2.5"
      : "ms-auto max-w-[min(42rem,85%)] rounded-2xl bg-muted px-4 py-2.5"
    : isSystem
      ? "border-border bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm"
      : "min-w-0 w-full";
  const rowClassName = nested
    ? "mx-auto w-full min-w-0 py-1"
    : "mx-auto w-full min-w-0 max-w-(--layout-thread-width) px-6 py-3";

  return (
    <MessagePrimitive.Root
      className={cn(
        rowClassName,
        isUser && "flex justify-end",
        isSystem && "py-2",
        fresh && ENTER_FADE,
      )}
      data-store-key={storeKeyOf(message)}
      data-role={role}
      data-slot="u1-message-row"
    >
      <div
        className={cn(className, "wrap-anywhere")}
        data-message-surface={isUser ? "user-bubble" : isSystem ? "system-note" : "assistant-text"}
      >
        {note !== undefined ? (
          <CustomNote source={note} />
        ) : execution !== undefined ? (
          <ExecutionRow record={execution} />
        ) : files !== undefined ? (
          <FileMentionRow files={files} />
        ) : (
          <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="never">
            {({ part, children }) => {
              if (isTurnGroup(part, "group-earlier"))
                return <EarlierSteps group={part}>{children}</EarlierSteps>;
              if (isTurnGroup(part, "group-reasoning"))
                return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
              if (part.type === "indicator") return null;
              return renderPart(part as EnrichedPartState, toolRenderers, renderNested, isUser);
            }}
          </MessagePrimitive.GroupedParts>
        )}
        {ending !== undefined && <MessageEndingNote ending={ending} />}
        {extra}
      </div>
      {actions}
    </MessagePrimitive.Root>
  );
}
