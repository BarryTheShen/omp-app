import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PanelFocusToken, PanelOpenReason } from "@/modules/U5/panel/contract";
import type { DiagnosticCommandRequest } from "../contract";
import { DiagnosticReportPanel } from "../reports/report-panel";
import type { ReportSnapshot } from "../reports/runner";
import {
  SECURITY_ACTIONS,
  type SecurityActionId,
  type SecurityActionInfo,
  securityActionOf,
  securityRequestOf,
} from "./actions";

export interface SecurityPanelProps {
  readonly open: boolean;
  readonly snapshot: ReportSnapshot;
  readonly onRun: (action: SecurityActionInfo, request: DiagnosticCommandRequest) => void;
  /** Runs the last action again after a failed run. Without it the panel offers no retry. */
  readonly onRetry?: () => void;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
}

const FIELD_LABEL = "text-muted-foreground text-xs";
const SELECT_CLASS =
  "border-input bg-background focus-visible:ring-ring w-full min-w-0 rounded-md border px-2 py-1.5 text-sm outline-none focus-visible:ring-2";

/** The `/security` panel: pick an action, type its details, run it. Its output is omp's words. */
export function SecurityPanel({
  open,
  snapshot,
  onRun,
  onRetry,
  onOpenChange,
  invokingFocus,
  restoreFocus,
}: SecurityPanelProps) {
  const actionFieldId = useId();
  const detailsFieldId = useId();
  const hintId = useId();
  const [actionId, setActionId] = useState<SecurityActionId>("status");
  const [details, setDetails] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const action = securityActionOf(actionId);

  const submit = () => {
    const built = securityRequestOf(action, details);
    if ("error" in built) {
      setProblem(built.error);
      return;
    }
    setProblem(undefined);
    onRun(action, built.request);
  };

  const toolbar = (
    <form
      aria-label="Security report"
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL} htmlFor={actionFieldId}>
          Security action
        </label>
        <select
          className={SELECT_CLASS}
          id={actionFieldId}
          onChange={(event) => {
            const next = SECURITY_ACTIONS.find((item) => item.id === event.target.value);
            if (next !== undefined) setActionId(next.id);
            setProblem(undefined);
          }}
          value={action.id}
        >
          {SECURITY_ACTIONS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <p className={FIELD_LABEL}>{action.summary}</p>
      {action.details !== "none" && (
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL} htmlFor={detailsFieldId}>
            {action.details === "required" ? "Details (required)" : "Details (optional)"}
          </label>
          <Input
            aria-describedby={action.hint === undefined ? undefined : hintId}
            aria-invalid={problem !== undefined}
            id={detailsFieldId}
            onChange={(event) => setDetails(event.target.value)}
            placeholder={action.placeholder}
            value={details}
          />
          {action.hint !== undefined && (
            <p className={FIELD_LABEL} id={hintId}>
              {action.hint}
            </p>
          )}
        </div>
      )}
      {problem !== undefined && (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      )}
      <div>
        <Button type="submit">Run</Button>
      </div>
    </form>
  );

  return (
    <DiagnosticReportPanel
      fallbackTitle="Security"
      invokingFocus={invokingFocus}
      onOpenChange={onOpenChange}
      onRetry={onRetry}
      open={open}
      restoreFocus={restoreFocus}
      snapshot={snapshot}
      toolbar={toolbar}
    />
  );
}
