import {
  BotIcon,
  ClockIcon,
  CpuIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HashIcon,
  type LucideIcon,
  ServerIcon,
  TargetIcon,
  TimerIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StatusChip, StatusIcon } from "./model";
import { type StatusBarInputs, useStatusBar } from "./use-status-bar";

const ICONS: Record<StatusIcon, LucideIcon> = {
  host: ServerIcon,
  folder: FolderIcon,
  git: GitBranchIcon,
  "pull-request": GitPullRequestIcon,
  session: HashIcon,
  model: CpuIcon,
  goal: TargetIcon,
  subagents: BotIcon,
  timer: TimerIcon,
  clock: ClockIcon,
};

const TONE_CLASS: Record<StatusChip["tone"], string> = {
  neutral: "text-muted-foreground",
  clean: "text-success",
  changed: "text-warning",
};

const ACCENT_CLASS: Record<number, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
};

/**
 * One segment: its icon (or a session's accent dot) and its text. The words that say what the text is
 * (the accessible label) are read by screen readers; sighted people see the text and the icon.
 */
function Segment({ chip, text }: { readonly chip: StatusChip; readonly text: string }) {
  const { segment } = chip;
  const Icon = chip.icon === undefined ? null : ICONS[chip.icon];
  const body = (
    <>
      {chip.accent === undefined ? null : (
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", ACCENT_CLASS[chip.accent])}
        />
      )}
      {Icon ? (
        <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", TONE_CLASS[chip.tone])} />
      ) : null}
      <span aria-hidden="true" className="min-w-0 truncate tabular-nums" data-segment-value="">
        {text}
      </span>
    </>
  );
  if (chip.href !== undefined) {
    const label = `${segment.accessibleLabel}, opens in a new tab`;
    return (
      <a
        aria-label={label}
        className="flex min-w-0 max-w-full items-center gap-1 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        data-segment={segment.id}
        href={chip.href}
        rel="noreferrer"
        target="_blank"
        title={label}
      >
        {body}
      </a>
    );
  }
  return (
    <span
      className="flex min-w-0 max-w-full items-center gap-1"
      data-segment={segment.id}
      title={segment.accessibleLabel}
    >
      {body}
      <span className="sr-only">{segment.accessibleLabel}</span>
    </span>
  );
}

/**
 * The status bar's segments: the host, the workspace folder, the git branch, the pull request, the session
 * id and name, the model, the goal, the running subagents, the active time and the local clock. A segment
 * with no value is not drawn, so the bar shows only what omp or the machine actually reported. Nothing here
 * takes focus, and nothing is announced: the clock and the timer are ambient.
 */
export function StatusSegments(props: StatusBarInputs) {
  const { chips } = useStatusBar(props);
  const shown = chips.flatMap((chip) =>
    chip.segment.value.state === "available"
      ? [{ chip, text: String(chip.segment.value.value) }]
      : [],
  );
  if (shown.length === 0) return null;
  return (
    <section
      aria-label="Session and workspace status"
      className="text-muted-foreground -m-1 flex min-w-0 flex-nowrap items-center gap-x-3 overflow-hidden p-1 text-xs"
      data-n1-status="true"
    >
      {shown.map(({ chip, text }) => (
        <Segment chip={chip} key={chip.segment.id} text={text} />
      ))}
    </section>
  );
}
