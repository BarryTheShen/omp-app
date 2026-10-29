import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ToolCard } from "../vendor/collab-web/components/transcript/ToolCard";
import {
  AssistantBody,
  EntryRow,
  Row,
} from "../vendor/collab-web/components/transcript/Transcript";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import { buildRows, type TranscriptRow, toolResults } from "./rows";
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
}: {
  readonly snapshot: ChatSnapshot;
  readonly onNearTop: () => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { entries, stream, streamDone, activeTools, working, hasOlder } = snapshot;
  const rows = useMemo(
    () => buildRows({ entries, stream, streamDone, activeTools, working }),
    [entries, stream, streamDone, activeTools, working],
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
    <div className="tl-frame">
      <section ref={scrollRef} className="tr-root tl-scroll" aria-label="Transcript">
        <div className="tl-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="tl-item"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <RowView row={row} results={results} active={activeTools} />
              </div>
            );
          })}
        </div>
      </section>
      {!empty && !virtualizer.isAtEnd() && (
        <button
          type="button"
          className="tl-latest"
          onClick={() => virtualizer.scrollToEnd({ behavior: "smooth" })}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

function RowView({
  row,
  results,
  active,
}: {
  readonly row: TranscriptRow;
  readonly results: ReadonlyMap<string, ToolResultMessage>;
  readonly active: ReadonlyMap<string, ActiveTool>;
}): ReactNode {
  switch (row.kind) {
    case "entry":
      return <EntryRow entry={row.entry} results={results} active={active} />;
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
  }
}
