import type { DiagnosticCommandRequest } from "../contract";

export interface SecurityConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
}

export type SecurityActionId =
  | "plan"
  | "scan"
  | "status"
  | "cancel"
  | "scans"
  | "show"
  | "import"
  | "export"
  | "validate"
  | "compare"
  | "disposition";

export interface SecurityActionInfo {
  readonly id: SecurityActionId;
  /** A plain-English name for the action, shown in the picker. */
  readonly label: string;
  /** A plain-English summary of the action, shown under the picker. */
  readonly summary: string;
  /** Whether the details box is hidden, optional, or required for this action. */
  readonly details: "none" | "optional" | "required";
  /** Shown inside the details box while it is empty. Set for every action that takes details. */
  readonly placeholder?: string;
  /** One or two plain sentences on what to type. Set for every action that takes details. */
  readonly hint?: string;
  /** An action that changes something or spends model budget asks first; nothing is sent until the person confirms. */
  readonly confirmation?: SecurityConfirmation;
  /** What the panel says when omp answers in the chat and prints no text here. */
  readonly chatNote?: string;
}

/** The `/security` subcommands in omp's order. The app builds `/security <action> <details>`; omp reads the rest. */
export const SECURITY_ACTIONS: readonly SecurityActionInfo[] = [
  {
    id: "plan",
    label: "Plan a scan",
    summary: "Make a plan for a security scan of this project.",
    details: "none",
  },
  {
    id: "scan",
    label: "Start a scan",
    summary: "Start a scan from a plan, or plan and start one now.",
    details: "optional",
    placeholder: "Plan id (optional)",
    hint: "Leave this empty to plan and start a scan of this project. Or type a plan id that starts with secplan_.",
    confirmation: {
      title: "Start this scan?",
      message:
        "The scan uses the session's model, so it spends model budget. Continue only if you want it to run.",
      confirmLabel: "Start the scan",
    },
  },
  {
    id: "status",
    label: "Show scan status",
    summary: "Show how a running scan is doing.",
    details: "optional",
    placeholder: "Operation id (optional)",
    hint: "Leave this empty to list every scan operation. Or type an operation id to see one.",
  },
  {
    id: "cancel",
    label: "Cancel a running scan",
    summary: "Stop a scan that is running.",
    details: "required",
    placeholder: "Operation id",
    hint: "The operation id of the scan to stop. Show scan status lists them.",
    confirmation: {
      title: "Stop this scan?",
      message: "omp will try to stop the running scan. Continue only if you want it stopped.",
      confirmLabel: "Stop the scan",
    },
  },
  {
    id: "scans",
    label: "List stored scans",
    summary: "List the scans saved for this project.",
    details: "none",
  },
  {
    id: "show",
    label: "Show a scan or resource",
    summary: "Show one stored scan.",
    details: "required",
    placeholder: "Scan id or security:// address",
    hint: "Type a scan id, or a security:// address for one scan or one finding.",
  },
  {
    id: "import",
    label: "Import findings",
    summary: "Add findings from a SARIF file or a Codex Security folder to this project's scans.",
    details: "required",
    placeholder: "File or folder path",
    hint: "The path to a SARIF file, or to a Codex Security bundle folder, relative to this project's folder.",
    confirmation: {
      title: "Import these findings?",
      message: "omp will add the findings in this file or folder to the project's stored scans.",
      confirmLabel: "Import",
    },
  },
  {
    id: "export",
    label: "Export findings",
    summary: "Save a stored scan to a file.",
    details: "required",
    placeholder: "Scan id --output path",
    hint: "Type the scan id, then --output and a file path. Add --format bundle, sarif or report to choose the format; bundle is the default.",
  },
  {
    id: "validate",
    label: "Validate a finding",
    summary: "Ask omp to check one finding. The answer appears in the chat.",
    details: "required",
    placeholder: "Finding address, or scan id and finding id",
    hint: "A security:// address for one finding, or a scan id and a finding id separated by a space.",
    confirmation: {
      title: "Check this finding?",
      message:
        "omp will ask the model to check this finding in the chat. This spends model budget.",
      confirmLabel: "Check the finding",
    },
    chatNote: "omp is checking this finding in the chat; its answer appears there.",
  },
  {
    id: "compare",
    label: "Compare two scans",
    summary: "See which findings are new, fixed or unchanged between two scans.",
    details: "required",
    placeholder: "Earlier scan id, later scan id",
    hint: "Type the scan id to compare from, then the scan id to compare to, separated by a space.",
  },
  {
    id: "disposition",
    label: "Set a finding's disposition",
    summary: "Record what you decided about one finding, and why.",
    details: "required",
    placeholder: "Scan id, finding id, status and reason",
    hint: "Type the scan id, the finding id and one status: open, false_positive, accepted_risk, fixed or wont_fix. Then type a reason; every status except open needs one.",
    confirmation: {
      title: "Set this disposition?",
      message: "omp will record the disposition and rationale you typed for this finding.",
      confirmLabel: "Set disposition",
    },
  },
];

/** The catalog entry for an action id. An id the catalog does not list is a bug, so this throws. */
export function securityActionOf(id: SecurityActionId): SecurityActionInfo {
  const action = SECURITY_ACTIONS.find((item) => item.id === id);
  if (action === undefined) throw new Error(`The security action ${id} is not in the catalog.`);
  return action;
}

/** The longest details text the app sends; omp's own limit is not documented here. */
export const SECURITY_DETAILS_MAX = 300;

export type SecurityArgsResult =
  | { readonly request: DiagnosticCommandRequest }
  | { readonly error: string };

/**
 * The `/security` request for one action and its details text. The details must be one line of at
 * most SECURITY_DETAILS_MAX characters, and an action that needs details must have some.
 */
export function securityRequestOf(action: SecurityActionInfo, details: string): SecurityArgsResult {
  const text = details.trim();
  if (action.details === "required" && text === "") {
    return { error: "Type the details this action needs." };
  }
  if ([...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    return { error: "Keep the details to one line." };
  }
  if (text.length > SECURITY_DETAILS_MAX) {
    return { error: `Keep the details under ${SECURITY_DETAILS_MAX} characters.` };
  }
  const args = action.details === "none" || text === "" ? action.id : `${action.id} ${text}`;
  return { request: { name: "security", args } };
}
