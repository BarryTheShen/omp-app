import type { AppClient } from "@omp-app/client";
import type { WorkThreadId } from "@omp-app/contracts";
import type { ReactNode } from "react";
import { useWorkThread } from "./threads";
import { AskCard, asksIn } from "./WorkbenchPanel";

/**
 * A thread's asks with a question still open, under the thread's title, answered in place as in Workbench: the lite
 * view above its message box, and the dashboard's threads that wait on you.
 */
export function ThreadOpenAsks({
  client,
  id,
  title,
}: {
  readonly client: AppClient;
  readonly id: WorkThreadId;
  readonly title: string;
}): ReactNode {
  const read = useWorkThread(client, id);
  if (read === null) return null;
  const asks = asksIn(read.entries);
  const open = read.entries.flatMap((entry) =>
    entry.type === "question" &&
    entry.questions.some((question) => !(asks.get(entry.id)?.sent.has(question.id) ?? false))
      ? [entry]
      : [],
  );
  return (
    <section aria-label={`Thread: ${title}`} className="flex flex-col gap-1.5">
      <h4 className="px-1 text-xs font-medium text-t3">{title}</h4>
      {open.map((entry) => (
        <AskCard
          key={entry.id}
          client={client}
          thread={id}
          entry={entry}
          ask={asks.get(entry.id)}
        />
      ))}
    </section>
  );
}
