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
import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import { cn } from "@/lib/utils";
import { fitSegments } from "./fit";
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
 * One segment: its icon (or a session's accent dot) and its whole text, which never wraps or gets cut. The words that
 * say what the text is (the accessible label) are read by screen readers; sighted people see the text and the icon.
 */
function Segment({
  chip,
  text,
  className,
}: {
  readonly chip: StatusChip;
  readonly text: string;
  readonly className?: string;
}) {
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
      {/* The reserved text sizes the value without showing it: the value keeps one width while its text changes. */}
      <span
        aria-hidden="true"
        className="tabular-nums grid after:invisible after:col-start-1 after:row-start-1 after:content-[attr(data-reserve)]"
        data-reserve={chip.reserve}
        data-segment-value=""
      >
        <span className="col-start-1 row-start-1">{text}</span>
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
      className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap", className)}
      data-segment={segment.id}
      title={chip.tooltip ?? segment.accessibleLabel}
    >
      {body}
      <span className="sr-only">{segment.accessibleLabel}</span>
    </span>
  );
}

/**
 * The segments the bar draws, most important first: the model with its thinking level, the workspace folder, and the git
 * branch. The other chips are built by the model but not drawn: the folder's tooltip carries the server and session ids.
 */
const BAR_SEGMENTS: readonly string[] = ["N2.model", "N2.path", "N2.git"];

function sameIds(left: ReadonlySet<string> | null, right: ReadonlySet<string>): boolean {
  if (left === null || left.size !== right.size) return false;
  return [...right].every((id) => left.has(id));
}

/**
 * The status bar's segments. Each keeps its whole text. When the bar is too narrow for all of them, the least important
 * one that does not fit is left out, never cut: the branch goes first, then the folder. Segments are measured where they
 * stand, hidden from view and from assistive technology, so the choice is made before the first paint. Nothing here
 * takes focus, and nothing is announced: the clock and the timer are ambient.
 */
export function StatusSegments(props: StatusBarInputs) {
  const { chips } = useStatusBar(props);
  const shown = chips.flatMap((chip) =>
    chip.segment.value.state === "available" && BAR_SEGMENTS.includes(chip.segment.id)
      ? [{ chip, text: String(chip.segment.value.value) }]
      : [],
  );
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string> | null>(null);
  const [measureCount, remeasure] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (section === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => remeasure());
    observer.observe(section);
    return () => observer.disconnect();
  }, [section]);
  const drawnKey = shown.map(({ chip, text }) => `${chip.segment.id}:${text}`).join("\n");
  // Measures only when what it measures may have changed: the texts drawn, or the room the observer reports. A tick
  // that draws nothing new (the clock, the active time) must not force a layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the drawn texts and the observer count re-measure on purpose; the measurement reads the DOM they change.
  useLayoutEffect(() => {
    if (section === null) return;
    const style = getComputedStyle(section);
    const room =
      section.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const widths = BAR_SEGMENTS.flatMap((id) => {
      const element = section.querySelector<HTMLElement>(`[data-segment="${id}"]`);
      return element ? [{ id, width: element.offsetWidth }] : [];
    });
    const fitting = fitSegments(widths, room, gap);
    setKept((current) => (sameIds(current, fitting) ? current : fitting));
  }, [section, drawnKey, measureCount]);
  if (shown.length === 0) return null;
  return (
    <section
      aria-label="Session and workspace status"
      className="text-muted-foreground relative -m-1 flex min-w-0 flex-nowrap items-center gap-x-3 overflow-hidden p-1 text-meta"
      data-n1-status="true"
      ref={setSection}
    >
      {shown.map(({ chip, text }) => (
        <Segment
          chip={chip}
          className={kept !== null && !kept.has(chip.segment.id) ? "invisible absolute" : undefined}
          key={chip.segment.id}
          text={text}
        />
      ))}
    </section>
  );
}
