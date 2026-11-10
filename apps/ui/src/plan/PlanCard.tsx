import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChatController } from "../chat/controller";
import { lostWithTheLink } from "../chat/openFailure";
import type { PlanProposal } from "../chat/store";
import { Clamped } from "../questions/Clamped";
import { Markdown } from "../vendor/collab-web/components/transcript/Markdown";

/** The plan's name as omp gives it to the chat: "fix-the-login" reads "Fix the login". */
export const planName = (title: string): string => {
  const words = title.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * omp proposed a plan and waits while plan mode is on. Shown above the chat's message box, as omp's other requests are,
 * and in the Questions panel (`inPanel`): the plan's start (Read all shows all of it, wide over the app), with Approve
 * (omp's "Approve and keep context": plan mode ends and the run on the plan starts in this chat) and Keep planning (the
 * review closes; plan mode stays on). Deciding in one place closes both.
 */
export function PlanCard({
  controller,
  proposal,
  inPanel = false,
}: {
  readonly controller: ChatController;
  readonly proposal: PlanProposal;
  readonly inPanel?: boolean;
}): ReactNode {
  const [plan, setPlan] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [wide, setWide] = useState(false);
  // A read the connection dropped under (a release restarts the server) is read again once the connection is back.
  const [tries, setTries] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new try reads the plan again
  useEffect(() => {
    let alive = true;
    let stopWaiting: (() => void) | undefined;
    controller
      .readPlan(proposal.planFilePath)
      .then((file) => {
        if (!alive) return;
        setPlan(file.content);
        setProblem(null);
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        setProblem(
          `Could not read the plan: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
        if (!lostWithTheLink(failure)) return;
        let away = false;
        stopWaiting = controller.client.onConnectionState((event) => {
          if (event.state !== "open") away = true;
          else if (away && alive) setTries((count) => count + 1);
        });
      });
    return () => {
      alive = false;
      stopWaiting?.();
    };
  }, [controller, proposal.planFilePath, tries]);
  const keepPlanning = (): void => controller.store.clearProposal();
  const approve = (): void => {
    setApproving(true);
    setProblem(null);
    controller
      .approvePlan(proposal)
      .catch((failure: unknown) =>
        setProblem(
          `Could not approve it: ${failure instanceof Error ? failure.message : String(failure)}`,
        ),
      )
      .finally(() => setApproving(false));
  };

  const text = (clamp: boolean): ReactNode =>
    plan === null ? (
      <p className="text-t3">Reading the plan…</p>
    ) : (
      <Clamped clamp={clamp} onReadAll={() => setWide(true)} label="The plan" className="text-t1">
        <Markdown text={plan} />
      </Clamped>
    );
  const foot = (
    <>
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <footer className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={keepPlanning}>
          Keep planning
        </Button>
        <Button type="button" size="sm" disabled={plan === null || approving} onClick={approve}>
          Approve
        </Button>
      </footer>
    </>
  );
  const body = (
    <>
      <header className="flex flex-col gap-0.5">
        <p className="font-medium text-t1">Plan ready for review</p>
        <p className="text-t2">{planName(proposal.title)}</p>
      </header>
      {text(true)}
      {foot}
      {wide && (
        <Dialog open onOpenChange={(open) => (open ? undefined : setWide(false))}>
          <DialogContent className="max-sm:h-[calc(100dvh-var(--safe-top)-var(--safe-bottom)-1rem)] flex flex-col gap-3 overflow-y-auto sm:max-w-3xl">
            <DialogTitle className="pr-8">{planName(proposal.title)}</DialogTitle>
            <DialogDescription>Plan ready for review</DialogDescription>
            {text(false)}
            {foot}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
  return inPanel ? (
    <article
      aria-label={`Plan: ${planName(proposal.title)}`}
      className="flex flex-col gap-3 rounded-xl border border-l3 bg-card p-3 shadow-sm"
    >
      {body}
    </article>
  ) : (
    <div className="flex max-h-[55%] min-h-0 flex-col px-4 pt-2 max-sm:max-h-[70%]">
      <div className="mx-auto flex min-h-0 w-full max-w-[720px] flex-col">
        <section
          role="dialog"
          aria-label="Plan ready for review"
          className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-l3 bg-card p-3.5 shadow-md"
        >
          {body}
        </section>
      </div>
    </div>
  );
}
