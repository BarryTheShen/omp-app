import type { OverlayOpener } from "@/modules/U4/dialogs/confirm-chat-delete";
import type { DiagnosticCommandRequest } from "../contract";
import type { DiagnosticReportRunner } from "../reports/runner";
import type { SecurityActionInfo } from "./actions";
import { openSecurityConfirm } from "./confirm";

/**
 * Runs one `/security` action. An action that changes something or spends model budget waits for
 * the person's confirmation first; if they decline, nothing is sent to omp.
 */
export async function runSecurityAction(
  overlay: OverlayOpener,
  runner: DiagnosticReportRunner,
  action: SecurityActionInfo,
  request: DiagnosticCommandRequest,
): Promise<void> {
  if (action.confirmation !== undefined) {
    const confirmed = await openSecurityConfirm(overlay, action.confirmation);
    if (!confirmed) return;
  }
  await runner.run(request, `Security: ${action.label}`, { emptyNote: action.chatNote });
}
