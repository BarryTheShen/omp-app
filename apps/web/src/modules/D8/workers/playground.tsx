import { type CapabilityMap, SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import { OverlayHost } from "../../../overlay";
import type { WorkersPanelSnapshot } from "./controller";
import { buildWorkersModel } from "./model";
import { WorkersPanelView } from "./view";

const threadId = ThreadId.parse("thread-workers-playground");
const NOW = Date.parse("2026-10-12T15:00:00Z");

function fixtureAgent({
  id,
  ...patch
}: Partial<Omit<RosterAgent, "id" | "key">> & { readonly id: string }): RosterAgent {
  return {
    id: SubagentId.parse(id),
    key: `${id}:1`,
    index: 0,
    agent: "task",
    agentSource: "bundled",
    status: "running",
    lastUpdate: NOW,
    threadId,
    incarnation: 1,
    terminalAt: null,
    lifecycleSeq: 1,
    progressSeq: null,
    metrics: { durationMs: 154_000, receivedAt: NOW, raw: { tokens: 18_420, cost: 0.0312 } },
    ...patch,
  };
}

const AGENTS: readonly RosterAgent[] = [
  fixtureAgent({
    id: "review-login",
    agent: "task",
    description: "Review the failing login tests",
    metrics: {
      durationMs: 95_000,
      receivedAt: NOW,
      raw: {
        resolvedModel: "fake/fake-model:high",
        tokens: 15_200,
        cost: 0.0123,
        currentTool: "bash",
        toolCount: 7,
      },
    },
    sessionFile: SessionFilePath.parse("/fixtures/chat/review-login.jsonl"),
  }),
  fixtureAgent({
    id: "summary-worker",
    description: "Summarize the build log",
    status: "completed",
    terminalAt: NOW - 20_000,
    metrics: { durationMs: 42_000, receivedAt: NOW, raw: { tokens: 6_050 } },
  }),
  fixtureAgent({
    id: "stopped-worker",
    description: "Scan the old branch",
    status: "aborted",
    terminalAt: NOW - 60_000,
    metrics: { durationMs: 9_000, receivedAt: NOW, raw: {} },
  }),
  fixtureAgent({
    id: "queued-worker",
    description: "Plan the next step",
    status: "pending",
    terminalAt: null,
    metrics: { durationMs: 0, receivedAt: NOW, raw: {} },
  }),
];

function fixtureRoster(): AgentRosterStoreSnapshot {
  const active = AGENTS.filter((agent) => agent.terminalAt === null).map((agent) => agent.key);
  return {
    threadId,
    revision: 1,
    lastSeq: 1,
    agents: Object.fromEntries(AGENTS.map((agent) => [agent.key, agent])),
    order: AGENTS.map((agent) => agent.key),
    active,
    recent: AGENTS.filter((agent) => agent.terminalAt !== null).map((agent) => agent.key),
  };
}

/** The playground's capabilities: omp can read and cancel workers, and no tan or vibe start is published. */
const CAPABILITIES: CapabilityMap = {
  [P1CapabilityKeys.transcript]: { state: "available", via: "omp" },
  [P1CapabilityKeys.cancel]: { state: "available", via: "omp" },
};

function fixtureSnapshot(): WorkersPanelSnapshot {
  return {
    model: buildWorkersModel({ snapshot: fixtureRoster(), now: NOW, capabilities: CAPABILITIES }),
    loading: false,
    error: null,
  };
}

function WorkersPlayground() {
  const [open, setOpen] = useState(
    () => !new URLSearchParams(window.location.search).has("closed"),
  );
  const openButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = (token: string) => {
    if (token === "workers-panel-open") openButton.current?.focus();
  };
  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="workers-playground">
      <Button ref={openButton} onClick={() => setOpen(true)} type="button" variant="outline">
        Open workers panel
      </Button>
      <WorkersPanelView
        open={open}
        position="right"
        snapshot={fixtureSnapshot()}
        invokingFocus="workers-panel-open"
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
        restoreFocus={restoreFocus}
        onOpenTranscript={() => undefined}
        onRetry={() => undefined}
        onStop={() => undefined}
      />
    </main>
  );
}

const root = document.getElementById("workers-playground-root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <OverlayHost>
        <WorkersPlayground />
      </OverlayHost>
    </StrictMode>,
  );
}
