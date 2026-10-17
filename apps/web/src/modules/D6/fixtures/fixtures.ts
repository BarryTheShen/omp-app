import type { InventoryId } from "@omp-app/contracts";
import type {
  CleanseProgress,
  DiagnosticCommandResult,
  PauseGateSnapshot,
  RecoveryActionResult,
  SecurityScanStatus,
} from "../contract";
import { D6_CAPABILITIES } from "../descriptors";

export interface D6FallbackFixture {
  readonly inventoryId: InventoryId;
  readonly title: string;
  readonly capability: typeof D6_CAPABILITIES.fallback;
  readonly reason: string;
  readonly limitations: readonly string[];
}

/** Synthetic fallback copy, not a transcript or result recorded from omp. */
export const D6_FALLBACK_FIXTURES: readonly D6FallbackFixture[] = [
  {
    inventoryId: "C1.debug",
    title: "Debug tools",
    capability: D6_CAPABILITIES.fallback,
    reason: "Debug tools are only available in omp's terminal.",
    limitations: ["The app cannot inspect omp's private logs or files."],
  },
  {
    inventoryId: "C1.report-panel",
    title: "Diagnostic reports",
    capability: D6_CAPABILITIES.fallback,
    reason: "Diagnostic reports are shown as a local fallback.",
    limitations: ["The app cannot open a terminal report here."],
  },
  {
    inventoryId: "C3.cleanse",
    title: "Cleanse",
    capability: D6_CAPABILITIES.fallback,
    reason: "Cleanse is not connected in this app build.",
    limitations: ["The app cannot start or cancel an omp cleanse yet."],
  },
  {
    inventoryId: "C3.cleanse-progress-panel",
    title: "Cleanse progress",
    capability: D6_CAPABILITIES.fallback,
    reason: "This panel shows local progress examples.",
    limitations: ["The app says when progress is not available."],
  },
  {
    inventoryId: "C3.debug-selector",
    title: "Debug picker",
    capability: D6_CAPABILITIES.fallback,
    reason: "This debug picker is a local fallback.",
    limitations: ["The app cannot open omp's diagnostic tools here."],
  },
  {
    inventoryId: "C3.omfg",
    title: "Rule drafting",
    capability: D6_CAPABILITIES.fallback,
    reason: "Rule drafting is not connected in this app build.",
    limitations: ["Saving this preview does not change omp."],
  },
  {
    inventoryId: "C3.omfg-rule-panel",
    title: "Rule preview",
    capability: D6_CAPABILITIES.fallback,
    reason: "This is a local rule preview.",
    limitations: ["The app does not save the draft to omp yet."],
  },
  {
    inventoryId: "C3.pause",
    title: "Pause command",
    capability: D6_CAPABILITIES.fallback,
    reason: "Pause is local to this app.",
    limitations: ["omp work keeps running."],
  },
  {
    inventoryId: "C3.pause-gate",
    title: "Pause controls",
    capability: D6_CAPABILITIES.fallback,
    reason: "Pause blocks input in this app only.",
    limitations: ["omp work is not stopped."],
  },
  {
    inventoryId: "C3.pause-screen",
    title: "Pause screen",
    capability: D6_CAPABILITIES.fallback,
    reason: "The pause screen is a local dialog.",
    limitations: ["Elapsed time measures only this app's pause."],
  },
] as const;

/** Synthetic stand-in shaped like omp's trace URL; no output here was recorded from omp. */
export const D6_SYNTHETIC_REDACTED_REPORT_FIXTURE: DiagnosticCommandResult = {
  command: "trace",
  status: "completed",
  lines: [
    {
      text: "http://127.0.0.1:43120/#/traces?s=%3CREDACTED%3APATH%3E",
      level: "info",
      redacted: true,
    },
  ],
  promptSettled: true,
  sessionSettled: true,
  safeUrl: "http://127.0.0.1:43120/#/traces?s=%3CREDACTED%3APATH%3E",
  requestId: "synthetic-trace-1",
  truncated: false,
};

/** Synthetic P1-style worker progress input; it is not an omp recording. */
export const D6_CLEANSE_PROGRESS_FIXTURE: CleanseProgress = {
  status: "running",
  wave: 2,
  totalWaves: 3,
  agentIds: ["agent-cleanse-1"],
  progress: 0.58,
  message: "Two checkers are reporting progress.",
};

/** Synthetic local snapshot, never an omp pause state. */
export const D6_PAUSE_GATE_FIXTURE: PauseGateSnapshot = {
  open: true,
  openedAt: 1_000,
  elapsedMs: 65_000,
  authoritative: false,
  reason: "Paused locally while you review the work.",
};

/** Synthetic successful outcome for recovery-action tests. */
export const D6_RECOVERY_SUCCESS_FIXTURE: RecoveryActionResult = {
  actionId: "refetch-report",
  status: "completed",
};

/** Synthetic safe finding for security-panel tests, not a scanner result recorded from omp. */
export const D6_SECURITY_SCAN_FIXTURE: SecurityScanStatus = {
  scanId: "scan-synthetic-1",
  status: "completed",
  findings: [
    {
      id: "finding-1",
      severity: "low",
      title: "A safe example finding",
      summary: "This synthetic finding contains no private path or credential.",
      status: "resolved",
      scanId: "scan-synthetic-1",
    },
  ],
};
