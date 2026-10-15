import type { AppErrorCode } from "@omp-app/contracts";

/**
 * omp's answer when a steer reaches a worker that is not listed as running: `Subagent not running: <id>`.
 * Sources: docs/rpc.md, "Steering subagents", failure responses (line 1064 at omp v18.8.9; line 957 at v18.6.1);
 * packages/coding-agent/src/modes/rpc/rpc-mode.ts:826 (v18.8.9) and :741 (v18.6.1). The client matches this
 * text (apps/web/src/modules/P1/client/client.ts:80-83); issue 1676 tracks replacing the match with an omp code.
 */
export const OMP_NOT_RUNNING_TEXT = "Subagent not running: worker-1";

export type SubagentCommand = "cancel" | "steer";

/**
 * One call to `cancel` or `steer` on the subagent client, with the answer omp gives. `sent` says whether the call
 * reached the session: a call refused in the browser (no capability, a blank message) sends nothing.
 */
export interface SubagentCommandCase {
  readonly name: string;
  readonly command: SubagentCommand;
  /** The text a steer sends; a blank one is refused before anything is sent. */
  readonly message?: string;
  /** The worker the call names; a case that leaves it out names worker-1. */
  readonly subagentId?: string;
  /** Leaves this command's capability out of the map, so the call fails before anything is sent. */
  readonly withoutCapability?: SubagentCommand;
  /** omp's result for `cancel_subagent`, or `accepted` for a steer omp takes. */
  readonly reply?: { readonly cancelled: boolean } | "accepted";
  /** omp's own error text, when omp answers the command with a failure. */
  readonly ompError?: string;
  readonly expect: {
    readonly outcome: "resolves" | "rejects";
    readonly code?: AppErrorCode;
    readonly retryable?: boolean;
    readonly sent: boolean;
  };
}

/**
 * Success and failure of cancel and steer. Every failure reads as a typed AppFailure; omp's words stay in `omp`.
 * omp answers `cancelled: false` for an id that is not a running subagent of this session: unknown, another
 * session's, finished, or already cancelled, so hosts can treat it as idempotent (docs/rpc.md, "Cancelling
 * subagents", v18.8.9 lines 1030-1035). The client reports that answer as a retryable conflict (client.ts:217-219).
 * The mapping is issue 1686.
 */
export const SUBAGENT_COMMAND_CASES: readonly SubagentCommandCase[] = [
  {
    name: "cancel: omp stops a running worker",
    command: "cancel",
    subagentId: "worker-2",
    reply: { cancelled: true },
    expect: { outcome: "resolves", sent: true },
  },
  {
    name: "cancel: omp answers false, and the client reports a retryable conflict (issue 1686)",
    command: "cancel",
    reply: { cancelled: false },
    expect: { outcome: "rejects", code: "conflict", retryable: true, sent: true },
  },
  {
    name: "cancel: the capability is missing, so nothing is sent",
    command: "cancel",
    withoutCapability: "cancel",
    expect: { outcome: "rejects", code: "unavailable", retryable: false, sent: false },
  },
  {
    name: "steer: omp takes the message",
    command: "steer",
    subagentId: "worker-2",
    message: "Check the failing test first.",
    reply: "accepted",
    expect: { outcome: "resolves", sent: true },
  },
  {
    name: "steer: omp refuses a worker it does not run, and the client matches its text (issue 1676)",
    command: "steer",
    message: "Check the failing test first.",
    ompError: OMP_NOT_RUNNING_TEXT,
    expect: { outcome: "rejects", code: "conflict", retryable: true, sent: true },
  },
  {
    name: "steer: a blank message is refused before anything is sent",
    command: "steer",
    message: "   ",
    reply: "accepted",
    expect: { outcome: "rejects", code: "invalid_args", retryable: false, sent: false },
  },
  {
    name: "steer: the capability is missing, so nothing is sent",
    command: "steer",
    message: "Check it.",
    withoutCapability: "steer",
    expect: { outcome: "rejects", code: "unavailable", retryable: false, sent: false },
  },
];
