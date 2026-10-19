import { groupPartByType, type MessagePrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useTranscriptDisplayPolicy } from "../policy";

export type ReasoningGroupPart = MessagePrimitive.GroupedParts.GroupPart<"group-reasoning">;

export const reasoningGroupBy = groupPartByType({
  reasoning: ["group-reasoning"],
});

export interface ReasoningDisclosureProps {
  readonly children: ReactNode;
  readonly streaming: boolean;
  readonly hidden?: boolean;
  readonly durationSeconds?: number;
}

function useThoughtDuration(streaming: boolean): number | undefined {
  const startedAt = useRef<number | undefined>(undefined);
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!streaming) {
      if (startedAt.current !== undefined) {
        setDurationSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
      }
      return;
    }
    if (startedAt.current === undefined) startedAt.current = Date.now();
    const update = () => {
      if (startedAt.current === undefined) return;
      setDurationSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  return durationSeconds;
}

function ThoughtTrigger({
  active,
  durationSeconds,
}: {
  readonly active: boolean;
  readonly durationSeconds?: number;
}) {
  const label =
    durationSeconds === undefined ? "Thought" : `Thought for ${durationSeconds.toString()}s`;
  return (
    <CollapsibleTrigger
      aria-label={label}
      className={cn(
        "group/trigger my-1 flex w-full min-w-0 items-baseline gap-2 text-start font-mono text-trace outline-none [font-variant-ligatures:none] focus-visible:underline transition-all motion-reduce:transition-none",
        active && "animate-pulse",
      )}
      data-u1-reasoning-trigger
      data-slot="reasoning-trigger"
    >
      <span
        aria-hidden="true"
        className="inline-block shrink-0 text-muted-foreground/50 transition-transform duration-(--duration-base) motion-reduce:transition-none group-data-panel-open/trigger:rotate-90"
      >
        &gt;
      </span>
      <span className="min-w-0 truncate text-muted-foreground group-hover/trigger:text-foreground">
        {label}
      </span>
    </CollapsibleTrigger>
  );
}

export function HiddenThinkingPulse() {
  return (
    <span
      aria-label="Thinking"
      className="my-1 flex w-full min-w-0 items-baseline gap-2 font-mono text-trace text-muted-foreground animate-pulse [font-variant-ligatures:none]"
      data-u1-thinking-pulse
      role="status"
    >
      <span aria-hidden="true" className="text-muted-foreground/50 before:content-['>']" />
      Thinking
    </span>
  );
}

export function ReasoningDisclosure({
  children,
  streaming,
  hidden = false,
  durationSeconds,
}: ReasoningDisclosureProps) {
  if (hidden) return streaming ? <HiddenThinkingPulse /> : null;
  return (
    <ReasoningRoot className="mb-3" data-u1-reasoning-group streaming={streaming} variant="ghost">
      <ThoughtTrigger active={streaming} durationSeconds={durationSeconds} />
      <ReasoningContent
        aria-busy={streaming}
        className="border-foreground/10 ms-[0.3125rem] border-s ps-4 data-closed:hidden"
        data-u1-reasoning-body
      >
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

export function ReasoningGroup({
  children,
  group,
}: {
  readonly children: ReactNode;
  readonly group: ReasoningGroupPart;
}) {
  const policy = useTranscriptDisplayPolicy();
  const streaming = group.status.type === "running";
  const durationSeconds = useThoughtDuration(streaming);
  const hidden = policy.thinking === "hidden";
  return (
    <ReasoningDisclosure durationSeconds={durationSeconds} hidden={hidden} streaming={streaming}>
      {children}
    </ReasoningDisclosure>
  );
}
