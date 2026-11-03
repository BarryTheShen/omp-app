import type {
  AgentSnapshot,
  SessionEntry,
  SubagentLifecyclePayload,
  SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import type { SubagentSnapshot } from "@omp-app/contracts/chat-host";
import { OctagonX, SendHorizontal, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatController } from "../chat/controller";
import { transcriptOnly } from "../chat/store";
import { type RowActions, TranscriptList } from "../chat/TranscriptList";
import { AgentsPanel } from "../vendor/collab-web/components/agents/AgentsPanel";
import { fmtCost, fmtDuration, fmtTokens } from "../vendor/collab-web/lib/format";

/** How often a running subagent's transcript is read again. */
const POLL_MS = 1200;
const NO_LIFECYCLE: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
/** A subagent's log only shows: nothing in it can be retried, edited or stopped from here. */
const READ_ONLY: RowActions = {
  onRetry: async () => undefined,
  continuesAt: null,
  onDontContinue: async () => undefined,
  onSwitchModel: () => undefined,
  onStopShell: async () => undefined,
  onDismissNotice: () => undefined,
  onShareOpened: () => undefined,
  onEdit: () => undefined,
  canEdit: false,
};

/** omp's roster statuses as collab-web's agents panel draws them. */
const PANEL_STATUS = {
  pending: "running",
  running: "running",
  completed: "idle",
  failed: "aborted",
  aborted: "aborted",
} as const satisfies Record<SubagentSnapshot["status"], AgentSnapshot["status"]>;

const isRunning = (agent: SubagentSnapshot): boolean =>
  agent.status === "running" || agent.status === "pending";

const nameOf = (agent: SubagentSnapshot): string => agent.description ?? agent.id;

function forPanel(agent: SubagentSnapshot): AgentSnapshot {
  return {
    id: agent.id,
    displayName: nameOf(agent),
    kind: "sub",
    status: PANEL_STATUS[agent.status],
    hasSessionFile: agent.sessionFile !== undefined,
    createdAt: agent.lastUpdate,
    lastActivity: agent.lastUpdate,
  };
}

/** The progress the panel reads, in pi-wire's shape (omp's own adds the agent's source, which the panel does not show). */
function progressOf(agent: SubagentSnapshot): SubagentProgressPayload | null {
  if (agent.progress === undefined) return null;
  return {
    index: agent.index,
    agent: agent.agent,
    task: agent.task ?? "",
    progress: agent.progress,
    ...(agent.sessionFile === undefined ? {} : { sessionFile: agent.sessionFile }),
    ...(agent.parentToolCallId === undefined ? {} : { parentToolCallId: agent.parentToolCallId }),
  };
}

/**
 * The Agent Hub of one chat: its subagents (collab-web's agents panel), and the one chosen with its live transcript,
 * its numbers, Kill and a message box, after collab-web's agent drawer. A column on the right of the pane.
 */
export function AgentHub({
  controller,
  agents,
  selected,
  onSelect,
  onClose,
}: {
  readonly controller: ChatController;
  readonly agents: readonly SubagentSnapshot[];
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onClose: () => void;
}): ReactNode {
  const listed = useMemo(() => agents.map(forPanel), [agents]);
  const progress = useMemo(
    () =>
      new Map(
        agents.flatMap((agent) => {
          const payload = progressOf(agent);
          return payload === null ? [] : [[agent.id, payload] as const];
        }),
      ),
    [agents],
  );
  const chosen = agents.find((agent) => agent.id === selected) ?? null;
  // The Hub takes the focus as it opens, so Esc closes it rather than stopping omp from the message box.
  const aside = useRef<HTMLElement | null>(null);
  useEffect(() => aside.current?.focus(), []);
  return (
    <aside
      ref={aside}
      tabIndex={-1}
      className="ag-drawer font-sans text-sm text-t1 outline-none"
      aria-label="Agent Hub"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="ag-drawer-head">
        <div className="ag-drawer-title">
          <span className="ag-drawer-name">Agents</span>
        </div>
        <div className="ag-drawer-actions">
          <button
            type="button"
            className="ag-iconbtn"
            aria-label="Close the Agent Hub"
            onClick={onClose}
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      </header>
      <div
        className={
          chosen === null
            ? "min-h-0 flex-1 overflow-y-auto"
            : "max-h-[40%] shrink-0 overflow-y-auto"
        }
      >
        <AgentsPanel
          agents={listed}
          progress={progress}
          lifecycle={NO_LIFECYCLE}
          selectedId={selected}
          onSelect={onSelect}
        />
      </div>
      {chosen !== null && <AgentLog key={chosen.id} controller={controller} agent={chosen} />}
    </aside>
  );
}

/** One subagent: its numbers, its transcript as it grows, Kill while it runs, and a message to it. */
function AgentLog({
  controller,
  agent,
}: {
  readonly controller: ChatController;
  readonly agent: SubagentSnapshot;
}): ReactNode {
  const running = isRunning(agent);
  const { entries, error } = useAgentTranscript(controller, agent.sessionFile, running);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const snapshot = useMemo(() => transcriptOnly(entries, running), [entries, running]);
  const section = useRef<HTMLElement | null>(null);
  // Kill and the message box go away with the run; the focus they had stays in the Hub, so Esc and Alt+A still work.
  useLayoutEffect(() => {
    if (!running && document.activeElement === document.body)
      section.current?.closest<HTMLElement>("aside")?.focus();
  }, [running]);
  const p = agent.progress;
  const contextPercent =
    p?.contextTokens !== undefined && p.contextWindow
      ? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
      : null;
  const send = (): void => {
    const message = draft.trim();
    if (message === "") return;
    setProblem(null);
    controller
      .steerSubagent(agent.id, message)
      .then(() => setDraft(""))
      .catch((failure: unknown) => setProblem(`Not sent: ${errorText(failure)}`));
  };
  return (
    <section
      ref={section}
      className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)]"
      aria-label={nameOf(agent)}
    >
      <div className="ag-drawer-head">
        <div className="ag-drawer-title">
          <span className="ag-drawer-name">{nameOf(agent)}</span>
          <span className={`ag-chip ag-chip--${PANEL_STATUS[agent.status]}`}>{agent.status}</span>
          {p?.resolvedModel !== undefined && (
            <ModelChip controller={controller} resolved={p.resolvedModel} />
          )}
        </div>
        {running && (
          <div className="ag-drawer-actions">
            <button
              type="button"
              className="ag-btn ag-btn--danger"
              onClick={() => {
                setProblem(null);
                controller
                  .cancelSubagent(agent.id)
                  .catch((failure: unknown) =>
                    setProblem(`Could not stop it: ${errorText(failure)}`),
                  );
              }}
            >
              <OctagonX size={13} aria-hidden />
              Kill
            </button>
          </div>
        )}
      </div>
      {p !== undefined && (
        <div className="ag-stats">
          <span className="ag-stat">
            <span className="ag-stat-label">tok</span>
            <span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
          </span>
          {contextPercent !== null && (
            <span className="ag-stat" title={`context ${fmtTokens(p.contextTokens ?? 0)}`}>
              <span className="ag-stat-label">ctx</span>
              <span className="ag-gauge">
                <span
                  className={
                    contextPercent > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"
                  }
                  style={{ width: `${contextPercent}%` }}
                />
              </span>
            </span>
          )}
          <span className="ag-stat">
            <span className="ag-stat-label">cost</span>
            <span className="ag-stat-value">{fmtCost(p.cost)}</span>
          </span>
          <span className="ag-stat">
            <span className="ag-stat-label">tools</span>
            <span className="ag-stat-value">{p.toolCount}</span>
          </span>
          <span className="ag-stat">
            <span className="ag-stat-value">{fmtDuration(p.durationMs)}</span>
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {agent.sessionFile === undefined ? (
          <div className="ag-empty">No transcript yet</div>
        ) : (
          <TranscriptList
            snapshot={snapshot}
            onNearTop={NOTHING}
            actions={READ_ONLY}
            welcome={null}
            label={`${nameOf(agent)}'s log`}
          />
        )}
        {error !== null && (
          <div className="ag-fetch-error" role="alert">
            Its transcript could not be read: {error}
          </div>
        )}
      </div>
      {problem !== null && (
        <div className="ag-fetch-error" role="alert">
          {problem}
        </div>
      )}
      {running && (
        <form
          className="ag-chat"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <input
            className="ag-chat-input"
            aria-label={`Message ${nameOf(agent)}`}
            value={draft}
            placeholder={`Message ${nameOf(agent)}…`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="ag-iconbtn"
            aria-label="Send"
            disabled={draft.trim() === ""}
          >
            <SendHorizontal size={15} aria-hidden />
          </button>
        </form>
      )}
    </section>
  );
}

const NOTHING = (): void => undefined;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** omp's thinking levels, the suffix of a subagent's `provider/id:level`. */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/**
 * The model a subagent runs, by its readable name and thinking level ("GPT-6 Luna · high"); omp's whole
 * `provider/id:level` is its tooltip. A chip that cut the raw form short could be misread ("gpt-6-l…" for "gpt-6.1").
 */
function ModelChip({
  controller,
  resolved,
}: {
  readonly controller: ChatController;
  readonly resolved: string;
}): ReactNode {
  const level = THINKING_SUFFIX.exec(resolved)?.[1] ?? null;
  const path = level === null ? resolved : resolved.slice(0, -(level.length + 1));
  const slash = path.indexOf("/");
  const provider = slash > 0 ? path.slice(0, slash) : null;
  const id = slash > 0 ? path.slice(slash + 1) : path;
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    controller
      .models()
      .then((models) => {
        const found = models.find(
          (model) => model.id === id && (provider === null || model.provider === provider),
        );
        if (alive) setName(found?.name ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [controller, id, provider]);
  return (
    <span className="ag-chip ag-chip--model" title={resolved}>
      {name ?? id}
      {level !== null && ` · ${level}`}
    </span>
  );
}

/**
 * A subagent's transcript as its file grows: read from where the last read ended, page after page while pages bring
 * more, again every {@link POLL_MS} while it runs, and once more when it has stopped. A file that was replaced is read
 * again from its start.
 */
function useAgentTranscript(
  controller: ChatController,
  file: string | undefined,
  running: boolean,
): { readonly entries: readonly SessionEntry[]; readonly error: string | null } {
  const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const read = useRef({ nextByte: 0, entries: [] as readonly SessionEntry[] });
  useEffect(() => {
    if (file === undefined) return;
    let stopped = false;
    let reading = false;
    const poll = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        for (;;) {
          const next = await controller.agentTranscript(file, read.current.nextByte);
          if (stopped) return;
          const fresh = next.entries as unknown as readonly SessionEntry[];
          const before = next.reset ? [] : read.current.entries;
          read.current = { nextByte: next.nextByte, entries: [...before, ...fresh] };
          if (next.reset || fresh.length > 0) setEntries(read.current.entries);
          setError(null);
          // A long transcript comes in pages: the last one brings no more bytes.
          if (next.nextByte <= next.fromByte) break;
        }
      } catch (failure) {
        if (!stopped) setError(errorText(failure));
      } finally {
        reading = false;
      }
    };
    void poll();
    if (!running) {
      return () => {
        stopped = true;
      };
    }
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [controller, file, running]);
  return { entries, error };
}
