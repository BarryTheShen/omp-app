import type { ApproveDialogRequest, DialogResponse, SelectDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { SelectDialog } from "./select";

/**
 * omp's tool approval (`ui.approve`) as omp shows it to a host without an approval dialog: its prompt over its choices,
 * in omp's order and words (`approvalChoices`). The choice taken is answered with omp's own answer for it, never with
 * its label. The labels come from this request's own choices, so a label picks its choice exactly; two choices with the
 * same label take the first, as omp's own select does.
 */
export function ApproveDialog({
  request,
  context,
}: {
  readonly request: ApproveDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const select: SelectDialogRequest = {
    kind: "select",
    id: request.id,
    title: request.title,
    options: request.choices.map((choice) => choice.label),
    timeoutMs: request.timeoutMs,
  };
  const answer = (response: DialogResponse): Promise<void> => {
    if (response.kind !== "select") return context.answer(response);
    const choice = request.choices.find((candidate) => candidate.label === response.value);
    return context.answer({ kind: "approve", answer: choice?.answer ?? "deny" });
  };
  return <SelectDialog request={select} context={{ ...context, answer }} />;
}
