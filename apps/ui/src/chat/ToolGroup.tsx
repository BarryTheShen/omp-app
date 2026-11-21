import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { ToolCard } from "../vendor/collab-web/components/transcript/ToolCard";
import { ThinkingBlock } from "../vendor/collab-web/components/transcript/Transcript";
import { FoldContext } from "../vendor/collab-web/lib/fold";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import {
  normalizeArgs,
  resolveToolRenderer,
  type ToolRenderHost,
} from "../vendor/collab-web/tool-render";
import type { GroupItem } from "./rows";

type Call = Extract<GroupItem, { readonly kind: "call" }>;

/** The call running now, in the group's line: what the model said it does, else its card's own one-line summary. */
function NowRunning({
  call,
  tool,
  host,
}: {
  readonly call: Call;
  readonly tool: ActiveTool | undefined;
  readonly host: ToolRenderHost | undefined;
}): ReactNode {
  const { args, intent } = normalizeArgs(tool?.args ?? call.args);
  const words = (call.intent ?? tool?.intent ?? intent)?.trim();
  if (words) return words;
  const { Summary } = resolveToolRenderer(call.name);
  return (
    <>
      {call.name} <Summary name={call.name} args={args} running host={host} />
    </>
  );
}

/** The groups opened in this page, by key: a group scrolled out of view and back keeps its state. */
const opened = new Set<string>();

/** "bash 3 · read 2 · edit 1": the calls by tool, most used first. */
function countsByTool(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count === 1 ? name : `${name} ${count}`))
    .join(" · ");
}

/**
 * A run of tool calls as one card (`groupToolRuns`): how many, by which tools, the call running now and how many
 * failed; a click shows the calls themselves, each the card it is outside a group. Alt+O opens or folds groups too.
 */
export function ToolGroup({
  groupKey,
  items,
  results,
  active,
  host,
}: {
  readonly groupKey: string;
  readonly items: readonly GroupItem[];
  readonly results: ReadonlyMap<string, ToolResultMessage>;
  readonly active: ReadonlyMap<string, ActiveTool>;
  readonly host: ToolRenderHost | undefined;
}): ReactNode {
  const fold = useContext(FoldContext).tools;
  const [open, setOpen] = useState(opened.has(groupKey) || (fold.epoch > 0 && fold.open));
  useEffect(() => {
    if (fold.epoch > 0) setOpen(fold.open);
  }, [fold.epoch, fold.open]);
  useEffect(() => {
    if (open) opened.add(groupKey);
    else opened.delete(groupKey);
  }, [open, groupKey]);

  const calls = items.flatMap((item) => (item.kind === "call" ? [item] : []));
  const running = calls.filter(
    (call) => results.get(call.id) === undefined && (active.has(call.id) || call.pending),
  );
  const failed = calls.filter((call) => results.get(call.id)?.isError === true).length;
  const now = running.at(-1);
  const status = now !== undefined ? "run" : failed > 0 ? "err" : "ok";

  return (
    <div className={`tv-card tv-group${failed > 0 ? " tv-card--error" : ""}`}>
      <button
        type="button"
        className="tv-head"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {status === "run" ? (
          <span className="tv-spin" role="img" aria-label="running" />
        ) : (
          <span className={`tv-status tv-status--${status}`} aria-hidden="true" />
        )}
        <span className="tv-name">{calls.length} tool calls</span>
        <span className="tv-sum">
          {now !== undefined ? (
            <NowRunning call={now} tool={active.get(now.id)} host={host} />
          ) : (
            countsByTool(calls.map((call) => call.name))
          )}
          {failed > 0 && <span className="tv-group-failed"> · {failed} failed</span>}
        </span>
        <span className="tv-chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="tv-group-body">
          {items.map((item) =>
            item.kind === "thinking" ? (
              <ThinkingBlock key={item.key} text={item.text} redacted={item.redacted} />
            ) : (
              <ToolCard
                key={item.id}
                toolCallId={item.id}
                name={item.name}
                intent={item.intent ?? active.get(item.id)?.intent}
                args={active.get(item.id)?.args ?? item.args}
                result={results.get(item.id)}
                host={host}
                running={
                  results.get(item.id) === undefined && (active.has(item.id) || item.pending)
                }
                partialResult={active.get(item.id)?.partialResult}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
