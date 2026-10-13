import { groupPartByType, type MessagePrimitive } from "@assistant-ui/react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
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
        "group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]",
        active && "shimmer motion-reduce:animate-none",
      )}
      data-u1-reasoning-trigger
      data-slot="reasoning-trigger"
    >
      <BrainIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="inline-block leading-none tabular-nums">{label}</span>
      <ChevronRightIcon
        aria-hidden="true"
        className="size-4 shrink-0 transition-transform duration-(--duration-base) motion-reduce:transition-none group-data-panel-open/trigger:rotate-90"
      />
    </CollapsibleTrigger>
  );
}

export function HiddenThinkingPulse() {
  return (
    <span
      aria-label="Thinking"
      className="text-muted-foreground inline-flex min-w-20 animate-pulse items-center py-1.5 text-sm motion-reduce:animate-none"
      data-u1-thinking-pulse
      role="status"
    >
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
      <ReasoningContent aria-busy={streaming} className="data-closed:hidden" data-u1-reasoning-body>
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
