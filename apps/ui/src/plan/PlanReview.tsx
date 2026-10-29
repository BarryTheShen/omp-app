import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChatController } from "../chat/controller";
import type { PlanProposal } from "../chat/store";
import { Markdown } from "../vendor/collab-web/components/transcript/Markdown";

/** The plan's name as omp gives it to the chat: "fix-the-login" reads "Fix the login". */
const readable = (title: string): string => {
  const words = title.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * omp proposed a plan: it is shown in full, with Approve (omp's "Approve and keep context": plan mode ends and the run
 * on the plan starts in this chat) and Keep planning (the review closes; plan mode stays on).
 */
export function PlanReview({
  controller,
  proposal,
}: {
  readonly controller: ChatController;
  readonly proposal: PlanProposal;
}): ReactNode {
  const [plan, setPlan] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  useEffect(() => {
    let alive = true;
    controller
      .readPlan(proposal.planFilePath)
      .then((file) => alive && setPlan(file.content))
      .catch(
        (failure: unknown) =>
          alive &&
          setProblem(
            `Could not read the plan: ${failure instanceof Error ? failure.message : String(failure)}`,
          ),
      );
    return () => {
      alive = false;
    };
  }, [controller, proposal.planFilePath]);
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) keepPlanning();
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Plan ready for review</DialogTitle>
          <DialogDescription>{readable(proposal.title)}</DialogDescription>
        </DialogHeader>
        <section className="tr-root max-h-[60vh] rounded-lg border border-l2" aria-label="The plan">
          {plan === null ? <p className="text-t3">Reading the plan…</p> : <Markdown text={plan} />}
        </section>
        {problem !== null && (
          <p role="alert" className="text-xs text-bad-ink">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={keepPlanning}>
            Keep planning
          </Button>
          <Button type="button" disabled={plan === null || approving} onClick={approve}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
