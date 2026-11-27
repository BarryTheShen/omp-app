import type { AppClient } from "@omp-app/client";
import type { ReactNode } from "react";
import { Markdown } from "../../vendor/collab-web/components/transcript/Markdown";
import { useWorkThreadList } from "./threads";

const WHEN = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * The day's briefing on the dashboard, over every chat's threads (the server writes it each morning at 09:00): what
 * moved since the day before, what waits on you, what is in progress, each thread with its chat's name.
 */
export function DashboardBriefing({ client }: { readonly client: AppClient }): ReactNode {
  const { list, missing } = useWorkThreadList(client);
  if (missing) return null;
  if (list === null) return <p className="text-sm text-t3">Reading the briefing…</p>;
  const briefing = list.briefing ?? null;
  if (briefing === null)
    return (
      <p className="text-sm text-t3">
        No briefing yet: the first is written at 9:00 in the morning, server time.
      </p>
    );
  return (
    <div data-tour="dashboard-briefing" className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-xs text-t3">Written {WHEN.format(briefing.at)}</span>
      <Markdown text={briefing.text} />
    </div>
  );
}
