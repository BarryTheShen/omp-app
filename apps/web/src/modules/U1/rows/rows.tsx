import {
  AlertCircleIcon,
  ChevronDownIcon,
  FileTextIcon,
  GitBranchIcon,
  ImageIcon,
  RotateCcwIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

export interface CustomMessageRowProps {
  readonly customType: string;
  readonly content: string;
  readonly display?: boolean;
  readonly detail?: string;
  readonly title?: string;
}

export interface FileMention {
  readonly path: string;
  readonly lineCount?: number;
  readonly image?: boolean;
  readonly skippedReason?: "tooLarge" | "binary";
}

export interface FileMentionRowProps {
  readonly files: readonly FileMention[];
}

export type SessionEntryKind =
  | "model-change"
  | "compaction-summary"
  | "branch-summary"
  | "credential-pin"
  | "custom-extension-state"
  | "session-init"
  | "thinking-level-change"
  | "title-change"
  | "reset-boundary"
  | "service-tier-change"
  | "ttsr-injection";

export interface SessionEntryRowProps {
  readonly kind: SessionEntryKind;
  readonly title?: string;
  readonly detail?: string;
}

export interface ProviderErrorRowProps {
  readonly message: string;
  readonly provider?: string;
  readonly status?: number;
  readonly details?: string;
}

export interface TerminalErrorRowProps {
  readonly message: string;
  readonly retryable?: boolean;
  readonly onRetry?: () => void;
}

export type RetryRecoveryState = "retrying" | "recovered" | "failed";

export interface RetryRecoveryRowProps {
  readonly attempt: number;
  readonly total: number;
  readonly delaySeconds?: number;
  readonly providerError?: string;
  readonly state: RetryRecoveryState;
  readonly onRetry?: () => void;
}

export interface ToolResultImage {
  readonly src: string;
  readonly alt: string;
}

export interface ToolResultFile {
  readonly name: string;
  readonly detail?: string;
}

export interface ToolResultAttachmentRowProps {
  readonly toolCallId: string;
  readonly images?: readonly ToolResultImage[];
  readonly files?: readonly ToolResultFile[];
}

const sessionLabels: Readonly<Record<SessionEntryKind, string>> = {
  "model-change": "Model changed",
  "compaction-summary": "Compaction summary",
  "branch-summary": "Branch summary",
  "credential-pin": "Session account pinned",
  "custom-extension-state": "Extension state",
  "session-init": "Session initialized",
  "thinking-level-change": "Thinking level changed",
  "title-change": "Session title changed",
  "reset-boundary": "Context reset",
  "service-tier-change": "Service tier changed",
  "ttsr-injection": "Rules updated",
};

function RowSurface({
  children,
  className,
  kind,
  variant = "card",
  ...props
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly kind: string;
  readonly variant?: "card" | "inline";
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className="mx-auto w-full max-w-(--layout-thread-width) px-6 py-1.5"
      data-u1-row-kind={kind}
      {...props}
    >
      {variant === "inline" ? (
        <div className={cn("border-border border-b py-1.5 text-sm", className)}>{children}</div>
      ) : (
        <div
          className={cn(
            "border-border bg-muted/30 text-foreground rounded-lg border px-3 py-2 text-sm",
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Safe framed fallback for display=true custom or hook messages. */
export function CustomMessageRow({
  customType,
  content,
  display = true,
  detail,
  title,
}: CustomMessageRowProps) {
  if (!display) return null;
  return (
    <RowSurface kind="custom-message">
      <div className="flex items-start gap-2" title={customType}>
        <FileTextIcon aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs font-medium tracking-wide">
            {title ?? "Extension message"}
          </p>
          <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{content}</p>
          {detail !== undefined && <p className="text-muted-foreground mt-1 text-xs">{detail}</p>}
        </div>
      </div>
    </RowSurface>
  );
}

/** The line under a file's path: why its text is not shown, or how much of it there is. */
function fileMentionDetail(file: FileMention): string {
  if (file.skippedReason === "binary") return "Skipped: binary file";
  if (file.skippedReason === "tooLarge") return "Skipped: too large";
  if (file.image) return "Image";
  if (file.lineCount === undefined) return "Line count unknown";
  return file.lineCount === 1 ? "1 line" : `${file.lineCount} lines`;
}

/** Compact file rows for an omp file mention. The system surface around them supplies the frame. */
export function FileMentionRow({ files }: FileMentionRowProps) {
  return (
    <div className="space-y-1.5" data-u1-row-kind="file-mention">
      {files.length === 0 && <p className="text-muted-foreground text-xs">No files to show.</p>}
      {files.map((file) => (
        <div className="flex items-start gap-2" key={file.path}>
          {file.image ? (
            <ImageIcon
              aria-hidden="true"
              className="text-muted-foreground mt-0.5 size-4 shrink-0"
            />
          ) : (
            <FileTextIcon
              aria-hidden="true"
              className="text-muted-foreground mt-0.5 size-4 shrink-0"
            />
          )}
          <div className="min-w-0">
            <p className="text-foreground break-all font-mono text-xs">{file.path}</p>
            <p className="text-muted-foreground text-xs">{fileMentionDetail(file)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Read-only session metadata rows; credential-bearing details are never accepted as props. */
export function SessionEntryRow({ kind, title, detail }: SessionEntryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const label = title ?? sessionLabels[kind];
  const expandable = kind === "compaction-summary" || kind === "branch-summary";
  return (
    <RowSurface kind={`session-entry-${kind}`} variant="inline">
      <div className="text-muted-foreground flex items-start gap-2 text-xs">
        <GitBranchIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {expandable ? (
          <div className="min-w-0">
            <button
              aria-expanded={expanded}
              className="hover:text-foreground inline-flex items-center gap-1 text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              type="button"
              onClick={() => setExpanded((value) => !value)}
            >
              <span>{label}</span>
              <ChevronDownIcon
                aria-hidden="true"
                className={cn("size-3 transition-transform", expanded && "rotate-180")}
              />
            </button>
            {expanded && detail !== undefined && (
              <p className="mt-1 max-h-24 overflow-auto ps-1">{detail}</p>
            )}
          </div>
        ) : (
          <p className="min-w-0 break-words">
            {detail === undefined ? label : `${label}: ${detail}`}
          </p>
        )}
      </div>
    </RowSurface>
  );
}

/** Bounded, expandable provider details; the compact message remains visible when collapsed. */
export function ProviderErrorRow({ message, provider, status, details }: ProviderErrorRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <RowSurface kind="provider-error" role="alert">
      <div className="flex items-start gap-2">
        <AlertCircleIcon aria-hidden="true" className="text-danger mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-danger font-medium">{message}</p>
          {(provider !== undefined || status !== undefined) && (
            <p className="text-muted-foreground mt-1 text-xs">
              {[provider, status === undefined ? undefined : `status ${status}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {details !== undefined && (
            <>
              <button
                aria-expanded={expanded}
                className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                type="button"
                onClick={() => setExpanded((value) => !value)}
              >
                Details
                <ChevronDownIcon
                  aria-hidden="true"
                  className={cn("size-3 transition-transform", expanded && "rotate-180")}
                />
              </button>
              {expanded && (
                <pre className="bg-background mt-2 max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
                  {details}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </RowSurface>
  );
}

/** Terminal/runtime error with an explicit retry action when the normalized error is retryable. */
export function TerminalErrorRow({ message, retryable = false, onRetry }: TerminalErrorRowProps) {
  return (
    <RowSurface kind="terminal-error" role="alert">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <AlertCircleIcon aria-hidden="true" className="text-danger mt-0.5 size-4 shrink-0" />
          <p className="text-danger break-words">{message}</p>
        </div>
        {retryable && onRetry !== undefined && (
          <button
            className="border-danger/40 text-danger hover:bg-danger-surface shrink-0 rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            type="button"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
      </div>
    </RowSurface>
  );
}

/** Automatic retry progress/recovery row with provider failure context kept compact. */
export function RetryRecoveryRow({
  attempt,
  total,
  delaySeconds,
  providerError,
  state,
  onRetry,
}: RetryRecoveryRowProps) {
  const message =
    state === "retrying"
      ? `Retrying${delaySeconds === undefined ? "" : ` in ${delaySeconds}s`} (${attempt}/${total})`
      : state === "recovered"
        ? "Recovered after retry"
        : "Retry failed";
  return (
    <RowSurface kind="retry-recovery" role={state === "failed" ? "alert" : "status"}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground flex items-center gap-2">
            <RotateCcwIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                state === "retrying" && "animate-spin motion-reduce:animate-none",
              )}
            />
            {message}
          </p>
          {providerError !== undefined && (
            <p className="text-muted-foreground mt-1 truncate ps-6 text-xs">{providerError}</p>
          )}
        </div>
        {state === "failed" && onRetry !== undefined && (
          <button
            className="border-border hover:bg-muted shrink-0 rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            type="button"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
      </div>
    </RowSurface>
  );
}

/** Attaches tool-returned images/files to the originating call instead of creating a new turn. */
export function ToolResultAttachmentRow({
  toolCallId,
  images = [],
  files = [],
}: ToolResultAttachmentRowProps) {
  return (
    <RowSurface data-tool-call-id={toolCallId} kind="tool-result-attachment">
      <div className="space-y-2">
        {images.map((image) => {
          const safe =
            image.src.startsWith("data:image/") ||
            image.src.startsWith("https://") ||
            image.src.startsWith("http://");
          return safe ? (
            <figure className="overflow-hidden rounded-md" key={`${image.alt}:${image.src}`}>
              <img alt={image.alt} className="max-h-48 max-w-full object-contain" src={image.src} />
            </figure>
          ) : (
            <p className="text-muted-foreground text-xs" key={`${image.alt}:${image.src}`}>
              Image unavailable: {image.alt}
            </p>
          );
        })}
        {files.map((file) => (
          <div
            className="border-border bg-background rounded-md border px-2 py-1.5"
            key={`${file.name}:${file.detail ?? ""}`}
          >
            <p className="font-medium">{file.name}</p>
            {file.detail !== undefined && (
              <p className="text-muted-foreground text-xs">{file.detail}</p>
            )}
          </div>
        ))}
        {images.length === 0 && files.length === 0 && (
          <p className="text-muted-foreground text-xs">No attachments returned.</p>
        )}
      </div>
    </RowSurface>
  );
}
