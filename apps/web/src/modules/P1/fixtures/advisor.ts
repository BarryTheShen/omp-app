import type { Omp } from "@omp-app/contracts";
import { FIXTURE_START } from "./common";

/**
 * Advisor notes as omp sends them. The advisor delivers a batch of notes as one custom message:
 * `customType: "advisor"`, `display: true`, `attribution: "agent"`, `details: { notes }`
 * (packages/coding-agent/src/session/session-advisors.ts:1864-1873, omp v18.8.9). A note has omp's
 * `AdvisorNote` shape (packages/tui/src/chat/messages.ts:292-301). Its age is `turnsAgo`: omp sets it only
 * when the batch is delivered after a later primary turn (session-advisors.ts:1778-1779), and the card shows
 * it as `T-<n>` (packages/tui/src/chat/advisor-message.ts:121). A note delivered in its own turn has no
 * `turnsAgo`. The text is a stand-in, since omp formats the batch text itself. The turn numbers are synthetic.
 */
export interface OmpAdvisorNote {
  readonly note: string;
  readonly severity?: "nit" | "concern" | "blocker";
  readonly advisor?: string;
  readonly turn?: number;
  readonly turnsAgo?: number;
}

export interface AdvisorNoteAgeCase {
  readonly name: string;
  readonly note: OmpAdvisorNote;
  /** The `turnsAgo` omp's rule gives this note: undefined when it was delivered in its own turn, else the count. */
  readonly expectTurnsAgo: number | undefined;
}

export const ADVISOR_NOTE_AGE_CASES: readonly AdvisorNoteAgeCase[] = [
  {
    name: "a note delivered in its own turn has no age",
    note: {
      note: "Check the migration order before the schema change.",
      severity: "concern",
      turn: 4,
    },
    expectTurnsAgo: undefined,
  },
  {
    name: "a note delivered two turns after it was written keeps its count",
    note: { note: "The retry drops the auth header.", severity: "blocker", turn: 4, turnsAgo: 2 },
    expectTurnsAgo: 2,
  },
  {
    name: "a note from a named advisor keeps the advisor and its count",
    note: {
      note: "Prefer the cached read.",
      severity: "nit",
      advisor: "reviewer",
      turn: 7,
      turnsAgo: 1,
    },
    expectTurnsAgo: 1,
  },
];

/** The custom message omp keeps for a batch of notes, in the wire's own shape. */
export function advisorBatchMessage(notes: readonly OmpAdvisorNote[]): Omp.CustomMessage {
  return {
    role: "custom",
    customType: "advisor",
    content: [{ type: "text", text: "Advisor notes (fixture stand-in)." }],
    display: true,
    attribution: "agent",
    details: { notes },
    timestamp: FIXTURE_START,
  };
}
