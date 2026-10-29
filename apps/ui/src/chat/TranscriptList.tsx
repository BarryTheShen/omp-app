import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ToolCard } from "../vendor/collab-web/components/transcript/ToolCard";
import {
  AssistantBody,
  EntryRow,
  Row,
} from "../vendor/collab-web/components/transcript/Transcript";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import { FailureRow } from "./FailureRow";
import { buildRows, type TranscriptRow, toolResults } from "./rows";
import { NoticeRow, ShellBlock } from "./ShellBlock";
import type { ChatSnapshot } from "./store";

/** A first guess at a row's height; every row is measured once drawn. */
const ESTIMATED_ROW_PX = 72;

/**
 * The transcript as a virtual list in TanStack Virtual's chat mode (https://tanstack.com/virtual/latest/docs/chat.md):
 * anchored to the end, it follows new output only while the reader is at the end, keeps the reader's place when older
 * entries are added on top, and draws only the rows on screen. The rows are collab-web's.
 */
export function TranscriptList({
  snapshot,
  onNearTop,
  actions,
  welcome,
}: {
  readonly snapshot: ChatSnapshot;
  readonly onNearTop: () => void;
  readonly actions: RowActions;
  /** A new chat's greeting while it is empty; null for a saved chat, which shows its entries as they load. */
  readonly welcome: { readonly folder: string } | null;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { entries, stream, streamDone, activeTools, working, hasOlder, shell, notices } = snapshot;
  const rows = useMemo(
    () => buildRows({ entries, stream, streamDone, activeTools, working, shell, notices }),
    [entries, stream, streamDone, activeTools, working, shell, notices],
  );
  const results = useMemo(() => toolResults(entries), [entries]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 6,
    paddingStart: 24,
    paddingEnd: 16,
  });

  // Start at the latest entry once the first window is there.
  const empty = rows.length === 0;
  useLayoutEffect(() => {
    if (!empty) virtualizer.scrollToEnd();
  }, [virtualizer, empty]);

  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index;
  useEffect(() => {
    if (firstIndex !== undefined && firstIndex < 3 && hasOlder) onNearTop();
  }, [firstIndex, hasOlder, onNearTop]);

  return (
    <div className="relative min-h-0 flex-1">
      <section ref={scrollRef} className="tr-root tl-scroll" aria-label="Transcript">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="tl-item absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <RowView row={row} results={results} active={activeTools} actions={actions} />
              </div>
            );
          })}
        </div>
      </section>
      {empty && welcome !== null && <Welcome folder={welcome.folder} />}
      {!empty && !virtualizer.isAtEnd() && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-l2 px-3 shadow-md"
          onClick={() => virtualizer.scrollToEnd({ behavior: "smooth" })}
        >
          <ArrowDown />
          Jump to latest
        </Button>
      )}
    </div>
  );
}

/** The end of a folder's path, which names it: `…/projects/omp-app` for a long one. */
function folderTail(folder: string): string {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts.length <= 2 ? folder : `…/${parts.slice(-2).join("/")}`;
}

/** A new chat's first screen: where omp will work, and the keys of the message box. */
function Welcome({ folder }: { readonly folder: string }): ReactNode {
  const keys: readonly (readonly [string, string])[] = [
    ["/", "commands"],
    ["@", "files"],
    ["!", "shell"],
    ["Enter", "send"],
  ];
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-9 opacity-90" />
      <p className="text-base font-medium text-t1">What are we working on?</p>
      <p className="max-w-full truncate font-mono text-xs text-t3">{folderTail(folder)}</p>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-t3">
        {keys.map(([key, label]) => (
          <li key={key}>
            <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px] text-t2">
              {key}
            </kbd>{" "}
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What rows offer: a failed request's Retry and Switch model, stopping a `!` command, dismissing a notice. */
export interface RowActions {
  readonly onRetry: () => Promise<void>;
  readonly onSwitchModel: () => void;
  readonly onStopShell: () => Promise<void>;
  readonly onDismissNotice: (id: number) => void;
}

function RowView({
  row,
  results,
  active,
  actions,
}: {
  readonly row: TranscriptRow;
  readonly results: ReadonlyMap<string, ToolResultMessage>;
  readonly active: ReadonlyMap<string, ActiveTool>;
  readonly actions: RowActions;
}): ReactNode {
  switch (row.kind) {
    case "entry":
      return <EntryRow entry={row.entry} results={results} active={active} />;
    case "failure":
      return (
        <Row kind="assistant" gutter="">
          <FailureRow
            error={row.error}
            latest={row.latest}
            onRetry={actions.onRetry}
            onSwitchModel={actions.onSwitchModel}
          />
        </Row>
      );
    case "stream":
      return (
        <Row kind="assistant" gutter="agent">
          <AssistantBody
            message={row.message}
            results={results}
            active={active}
            pending={row.pending}
          />
        </Row>
      );
    case "tools":
      return (
        <Row kind="assistant" gutter={row.first ? "agent" : ""}>
          {row.tools.map((tool) => (
            <ToolCard
              key={tool.toolCallId}
              toolCallId={tool.toolCallId}
              name={tool.toolName}
              intent={tool.intent}
              args={tool.args}
              running
              partialResult={tool.partialResult}
            />
          ))}
        </Row>
      );
    case "working":
      return (
        <Row kind="assistant" gutter="agent">
          <div className="tr-shimmer">thinking…</div>
        </Row>
      );
    case "shell":
      return (
        <Row kind="assistant" gutter="">
          <ShellBlock run={row.run} onStop={actions.onStopShell} />
        </Row>
      );
    case "notice":
      return (
        <Row kind="assistant" gutter="">
          <NoticeRow notice={row.notice} onDismiss={actions.onDismissNotice} />
        </Row>
      );
  }
}
