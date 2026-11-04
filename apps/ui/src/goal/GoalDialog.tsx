import { type ReactNode, useState } from "react";
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
import { isImeEnter } from "../keys/ime";

/** Sets a goal for a chat (omp's goal mode): its objective, and a token budget if wanted. Open while `controller` is set. */
export function GoalDialog({
  controller,
  onClose,
}: {
  readonly controller: ChatController | null;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Dialog
      open={controller !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {controller !== null && <GoalForm controller={controller} onClose={onClose} />}
    </Dialog>
  );
}

function GoalForm({
  controller,
  onClose,
}: {
  readonly controller: ChatController;
  readonly onClose: () => void;
}): ReactNode {
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tokens = budget.trim() === "" ? undefined : Number(budget);
  const budgetWrong = tokens !== undefined && (!Number.isInteger(tokens) || tokens <= 0);
  const submit = (): void => {
    if (objective.trim() === "" || budgetWrong || saving) return;
    setSaving(true);
    setProblem(null);
    controller
      .goal("create", objective.trim(), tokens)
      .then(onClose)
      .catch((failure: unknown) =>
        setProblem(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setSaving(false));
  };
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Set a goal</DialogTitle>
        <DialogDescription>omp keeps the goal for this chat and works toward it.</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-t2">
          Objective
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to take the objective
            autoFocus
            rows={3}
            className="resize-none rounded-md border border-l2 bg-transparent px-2.5 py-2 text-t1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !isImeEnter(event)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-t2">
          Token budget (optional)
          <input
            inputMode="numeric"
            className="h-8 rounded-md border border-l2 bg-transparent px-2.5 text-t1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={budget}
            aria-invalid={budgetWrong}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        {(problem !== null || budgetWrong) && (
          <p role="alert" className="text-xs text-bad-ink">
            {budgetWrong ? "The budget is a whole number of tokens." : problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={objective.trim() === "" || budgetWrong || saving}>
            Set goal
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
