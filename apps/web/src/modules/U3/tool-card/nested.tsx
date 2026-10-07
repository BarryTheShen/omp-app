import type {
  MessageState,
  MessageStatus,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import {
  fromThreadMessageLike,
  ReadonlyThreadProvider,
  ThreadPrimitive,
} from "@assistant-ui/react";
import type { ToolCallId } from "@omp-app/contracts";
import { ToolCallId as ToolCallIdSchema } from "@omp-app/contracts";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { EmptyState } from "@/components/blocks";
import { MessageParts } from "@/modules/U1/parts";
import { ReadOnlyNestedTranscript } from "@/modules/U1/thread";
import type { ToolRendererMap } from "@/modules/U1/tool-slots";
import type { NestedTranscriptSource } from "./contract";

const COMPLETE_UNKNOWN_STATUS: MessageStatus = { type: "complete", reason: "unknown" };

export const MAX_NESTED_TRANSCRIPT_DEPTH = 32;

export interface NestedTranscriptProps extends NestedTranscriptSource {
  /** Reuses the parent thread's tool renderers for every nested message. */
  readonly toolRenderers?: ToolRendererMap;
  /** Names the tool whose task transcript is shown. */
  readonly taskName?: string;
}

interface NestedTranscriptPath {
  readonly taskIds: readonly ToolCallId[];
  readonly messageArrays: readonly NestedTranscriptSource["messages"][];
}

interface NestedMessageProps {
  readonly message: MessageState;
  readonly depth: number;
  readonly path: NestedTranscriptPath;
  readonly toolRenderers: ToolRendererMap | undefined;
}

/** Read-only transcript composition for tool messages and other nested message arrays. */
export function NestedTranscript({
  messages,
  parentTaskId,
  depth,
  taskName,
  toolRenderers,
}: NestedTranscriptProps) {
  return (
    <NestedTranscriptView
      depth={depth}
      messages={messages}
      parentTaskId={parentTaskId}
      path={{ taskIds: [], messageArrays: [] }}
      taskName={taskName}
      toolRenderers={toolRenderers}
    />
  );
}

function NestedTranscriptView({
  messages,
  parentTaskId,
  depth,
  path,
  taskName,
  toolRenderers,
}: NestedTranscriptProps & { readonly path: NestedTranscriptPath }) {
  const label = transcriptLabel(taskName, parentTaskId);
  const unavailableReason = depthReason(depth);
  if (unavailableReason !== undefined) {
    return (
      <UnavailableNestedTranscript label={label} messages={messages} reason={unavailableReason} />
    );
  }
  if (parentTaskId !== undefined && path.taskIds.includes(parentTaskId)) {
    return (
      <UnavailableNestedTranscript
        label={label}
        messages={messages}
        reason="This transcript contains a repeated task."
      />
    );
  }
  if (path.messageArrays.includes(messages)) {
    return (
      <UnavailableNestedTranscript
        label={label}
        messages={messages}
        reason="This transcript contains a loop."
      />
    );
  }
  const graphIssue = nestedGraphIssue(messages, depth, path, parentTaskId);
  if (graphIssue !== undefined) {
    return <UnavailableNestedTranscript label={label} messages={messages} reason={graphIssue} />;
  }
  if (messages.length === 0) {
    return (
      <ReadOnlyNestedSurface label={label} messages={messages}>
        <EmptyState
          hint="No messages were recorded for this task."
          title="No nested messages"
          variant="compact"
        />
      </ReadOnlyNestedSurface>
    );
  }

  const nextPath: NestedTranscriptPath = {
    taskIds: parentTaskId === undefined ? path.taskIds : [...path.taskIds, parentTaskId],
    messageArrays: [...path.messageArrays, messages],
  };

  return (
    <NestedTranscriptThread
      depth={depth}
      label={label}
      messages={messages}
      parentTaskId={parentTaskId}
      path={nextPath}
      toolRenderers={toolRenderers}
    />
  );
}

function NestedTranscriptThread({
  messages,
  parentTaskId,
  depth,
  path,
  label,
  toolRenderers,
}: NestedTranscriptProps & {
  readonly label: string;
  readonly path: NestedTranscriptPath;
}) {
  const threadMessages = useMemo(() => {
    try {
      return toThreadMessages(messages, `${parentTaskId ?? "transcript"}-${depth}`);
    } catch {
      return undefined;
    }
  }, [depth, messages, parentTaskId]);
  if (threadMessages === undefined) {
    return (
      <UnavailableNestedTranscript
        label={label}
        messages={messages}
        reason="Some messages could not be displayed."
      />
    );
  }

  return (
    <ReadonlyThreadProvider messages={threadMessages}>
      <ReadOnlyNestedSurface label={label} messages={threadMessages}>
        <ThreadPrimitive.Messages>
          {({ message }) => (
            <NestedMessage
              depth={depth}
              key={message.id}
              message={message}
              path={path}
              toolRenderers={toolRenderers}
            />
          )}
        </ThreadPrimitive.Messages>
      </ReadOnlyNestedSurface>
    </ReadonlyThreadProvider>
  );
}

function NestedMessage({ message, depth, path, toolRenderers }: NestedMessageProps) {
  return (
    <MessageParts
      message={message}
      nested
      renderNested={(part) =>
        part.messages === undefined ? undefined : (
          <NestedToolCall
            depth={depth}
            key={part.toolCallId}
            messages={part.messages}
            taskId={part.toolCallId}
            taskName={part.toolName}
            path={path}
            toolRenderers={toolRenderers}
          />
        )
      }
      toolRenderers={toolRenderers}
    />
  );
}

function NestedToolCall({
  messages,
  taskId,
  taskName,
  depth,
  path,
  toolRenderers,
}: {
  readonly messages: NestedTranscriptSource["messages"];
  readonly taskId: string;
  readonly taskName: string;
  readonly depth: number;
  readonly path: NestedTranscriptPath;
  readonly toolRenderers: ToolRendererMap | undefined;
}) {
  const parsedTaskId = ToolCallIdSchema.safeParse(taskId);
  if (!parsedTaskId.success) {
    return (
      <UnavailableNestedTranscript
        label={transcriptLabel(taskName, undefined)}
        messages={messages}
        reason="This transcript has an invalid task reference."
      />
    );
  }
  return (
    <NestedTranscriptView
      depth={depth + 1}
      messages={messages}
      parentTaskId={parsedTaskId.data}
      path={path}
      taskName={taskName}
      toolRenderers={toolRenderers}
    />
  );
}

function UnavailableNestedTranscript({
  messages,
  label,
  reason,
}: {
  readonly messages: NestedTranscriptSource["messages"];
  readonly label: string;
  readonly reason: string;
}) {
  return (
    <ReadOnlyNestedSurface label={label} messages={messages}>
      <EmptyState hint={reason} title="Nested transcript unavailable" variant="compact" />
    </ReadOnlyNestedSurface>
  );
}

function depthReason(depth: number): string | undefined {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    return "The nesting level is invalid.";
  }
  if (depth >= MAX_NESTED_TRANSCRIPT_DEPTH) {
    return `This transcript is deeper than ${MAX_NESTED_TRANSCRIPT_DEPTH} levels.`;
  }
  return undefined;
}

function transcriptLabel(
  taskName: string | undefined,
  parentTaskId: ToolCallId | undefined,
): string {
  const readableName = taskName
    ?.replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  if (
    readableName !== undefined &&
    readableName.length > 0 &&
    readableName.toLowerCase() !== "task"
  ) {
    return `${readableName[0]?.toUpperCase()}${readableName.slice(1)} task transcript`;
  }
  return parentTaskId === undefined ? "Nested transcript" : "Task transcript";
}

function nestedGraphIssue(
  messages: NestedTranscriptSource["messages"],
  depth: number,
  path: NestedTranscriptPath,
  parentTaskId: ToolCallId | undefined,
): string | undefined {
  const taskIds = new Set<string>(path.taskIds);
  if (parentTaskId !== undefined) taskIds.add(parentTaskId);
  const activeArrays = new Set<NestedTranscriptSource["messages"]>(path.messageArrays);
  const visitedArrays = new WeakSet<object>();

  const visit = (
    current: NestedTranscriptSource["messages"],
    currentDepth: number,
  ): string | undefined => {
    if (activeArrays.has(current)) return "This transcript contains a loop.";
    if (visitedArrays.has(current)) return "This transcript repeats a nested conversation.";
    visitedArrays.add(current);
    activeArrays.add(current);
    for (const message of current) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.messages === undefined) continue;
        if (taskIds.has(part.toolCallId)) return "This transcript contains a repeated task.";
        const nestedDepth = currentDepth + 1;
        if (depthReason(nestedDepth) !== undefined) continue;
        taskIds.add(part.toolCallId);
        const issue = visit(part.messages, nestedDepth);
        taskIds.delete(part.toolCallId);
        if (issue !== undefined) return issue;
      }
    }
    activeArrays.delete(current);
    return undefined;
  };

  return visit(messages, depth);
}

type ThreadMessagePart = Exclude<ThreadMessageLike["content"], string>[number];
type ToolCallPart = Extract<ThreadMessagePart, { readonly type: "tool-call" }>;
type ThreadMessageWithParts = ThreadMessageLike & {
  readonly content: readonly ThreadMessagePart[];
};

function toThreadMessages(
  messages: NestedTranscriptSource["messages"],
  seed: string,
): readonly ThreadMessage[] {
  return pairToolResults(messages).map((message, index) =>
    fromThreadMessageLike(message, `nested-${seed}-${index}`, COMPLETE_UNKNOWN_STATUS),
  );
}

function pairToolResults(
  messages: NestedTranscriptSource["messages"],
): readonly ThreadMessageLike[] {
  const output: ThreadMessageLike[] = [];
  const callPositions = new Map<
    ToolCallPart["toolCallId"],
    {
      readonly parts: ThreadMessagePart[];
      readonly index: number;
    }
  >();

  for (const message of messages) {
    if (message.role !== "assistant" || !hasMessageParts(message)) {
      output.push(message);
      continue;
    }
    const parts = [...message.content];
    let removedResults = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined || part.type !== "tool-call") continue;
      const prior = callPositions.get(part.toolCallId);
      if (prior === undefined) {
        callPositions.set(part.toolCallId, { parts, index });
        continue;
      }
      if (part.result === undefined) continue;
      const call = prior.parts[prior.index];
      if (call === undefined || call.type !== "tool-call") continue;
      prior.parts[prior.index] = {
        ...call,
        result: part.result,
        isError: part.isError,
        isPreliminary: false,
      };
      parts.splice(index, 1);
      index -= 1;
      removedResults += 1;
    }
    if (removedResults > 0 && parts.length === 0) continue;
    output.push({ ...message, content: parts });
  }
  return output;
}

function hasMessageParts(message: ThreadMessageLike): message is ThreadMessageWithParts {
  return Array.isArray(message.content);
}

function ReadOnlyNestedSurface({
  messages,
  label,
  children,
}: {
  readonly messages: NestedTranscriptSource["messages"];
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="w-full min-w-0">
      <ReadOnlyNestedTranscript label={label} messages={messages}>
        {children}
      </ReadOnlyNestedTranscript>
    </div>
  );
}
