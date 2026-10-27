import { AppFailure } from "@omp-app/contracts";
import type { DialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { ApproveDialog } from "./approve";
import { AskDialog } from "./ask";
import { ConfirmDialog } from "./confirm";
import { EditorDialog } from "./editor";
import { InputDialog } from "./input";
import { SelectDialog } from "./select";

function unreachable(request: never): never {
  throw new AppFailure(
    {
      code: "internal",
      message: "The dialog request kind is not supported by U4.",
      retryable: false,
    },
    { cause: request },
  );
}

/** The renderer callback supplied to DialogHostController by U4.3 composition. */
export function renderDialogRequest(request: DialogRequest, context: DialogRenderContext) {
  switch (request.kind) {
    case "select":
      return <SelectDialog request={request} context={context} />;
    case "confirm":
      return <ConfirmDialog request={request} context={context} />;
    case "input":
      return <InputDialog request={request} context={context} />;
    case "editor":
      return <EditorDialog request={request} context={context} />;
    case "ask":
      return <AskDialog request={request} context={context} />;
    case "approve":
      return <ApproveDialog request={request} context={context} />;
    default:
      return unreachable(request);
  }
}
