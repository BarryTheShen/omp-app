import { Maximize2, Minimize2, Minus } from "lucide-react";
import { type ReactNode, use, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../chat/controller";
import { ThreadOpenAsks } from "../panels/workbench/ThreadOpenAsks";
import { useWorkThreadList } from "../panels/workbench/threads";
import { LiteContext } from "./LiteContext";

/** How the card shows: docked above the message box, folded to one line, or over the whole chat. */
type Size = "docked" | "folded" | "full";

/**
 * In the lite view, which has no side panel: the questions this chat's agent asked in its Workbench threads show as
 * omp's questions that stop the chat do, docked above the message box, answered there. The card folds to one line, or
 * opens over the whole chat; a question that arrives while it is folded unfolds it. Nothing in the full app.
 */
export function LiteQuestions({ controller }: { readonly controller: ChatController }): ReactNode {
  const lite = use(LiteContext);
  const { list } = useWorkThreadList(controller.client);
  const mine = (list?.threads ?? []).filter(
    (thread) =>
      thread.owner !== null && thread.owner === controller.threadId && thread.unanswered > 0,
  );
  const open = mine.reduce((count, thread) => count + thread.unanswered, 0);
  const [size, setSize] = useState<Size>("docked");
  const before = useRef(open);
  useEffect(() => {
    if (open > before.current) setSize((current) => (current === "folded" ? "docked" : current));
    before.current = open;
  }, [open]);

  if (lite === null || open === 0) return null;
  const counted = open === 1 ? "1 question waits for you" : `${open} questions wait for you`;

  if (size === "folded")
    return (
      <div className="px-4 pt-2">
        <section
          aria-label="Questions from omp, folded"
          className="mx-auto flex w-full max-w-[720px] items-center gap-2 rounded-xl border border-l3 bg-card px-3 py-1.5 shadow-md"
        >
          <p className="min-w-0 flex-1 truncate text-sm text-t1">{counted}</p>
          <Button size="sm" onClick={() => setSize("docked")}>
            Show
          </Button>
        </section>
      </div>
    );

  const full = size === "full";
  return (
    <div
      className={
        full
          ? "absolute inset-0 z-20 flex flex-col bg-panel p-2"
          : "flex max-h-[55%] min-h-0 flex-col px-4 pt-2 max-sm:max-h-[70%]"
      }
    >
      <section
        aria-label="Questions from omp"
        className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-hidden rounded-xl border border-l3 bg-card shadow-md"
      >
        <header className="flex shrink-0 items-center gap-1 border-b border-l2 py-1 pr-1 pl-3">
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="text-t1">{counted}</span>
            <span className="text-t3"> · omp keeps working</span>
          </p>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Fold the questions"
            title="Fold the questions"
            onClick={() => setSize("folded")}
          >
            <Minus />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={
              full ? "Show the questions above the message box" : "Show the questions over the chat"
            }
            title={
              full ? "Show the questions above the message box" : "Show the questions over the chat"
            }
            onClick={() => setSize(full ? "docked" : "full")}
          >
            {full ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {mine.map((thread) => (
            <ThreadOpenAsks
              key={thread.id}
              client={controller.client}
              id={thread.id}
              title={thread.title}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
